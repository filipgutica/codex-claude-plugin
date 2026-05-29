// fallow-ignore-file unused-file
// fallow-ignore-file code-duplication
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Constants and types

type Mode = 'plan' | 'review'

type RuntimeFiles = {
  eventLogPath: string
  hookPath: string
  promptPath: string
  settingsPath: string
  statePath: string
  runtimeDir: string
}

type CommandResult = {
  stdout: string
  stderr: string
}

type ParsedArgs = {
  mode: Mode
  answer?: string
  answerFile?: string
  prompt?: string
  promptFile?: string
  resumeFile?: string
  timeoutMs: number
  idleTimeoutMs: number
  hardTimeoutMs?: number
}

type HookEvent = {
  event: unknown
  at?: unknown
  transcriptPath?: unknown
}

type AdviserSessionState = {
  schemaVersion: 1
  cwd: string
  mode: Mode
  sessionId: string
  sessionName: string
  runtimeFiles: RuntimeFiles
  lastQuestion?: string
  createdAt: string
}

type StopOrQuestion =
  | { kind: 'stop', stopEvent: HookEvent }
  | { kind: 'question', question: string }

type StopOrQuestionState = {
  seenEventCount: number
  lastQuestion: string
}

const READ_ONLY_TOOLS = 'Read,Glob,Grep,LS'
const REVIEW_MODEL = 'sonnet'
const DEFAULT_TIMEOUT_MS = 300000
const DEFAULT_IDLE_TIMEOUT_MS = 120000
const DEFAULT_COMMAND_TIMEOUT_MS = 30000
const HOOK_POLL_MS = 250
const PANE_STREAM_POLL_MS = 1000
const PANE_STREAM_HEARTBEAT_MS = 30000
const PANE_STREAM_MAX_LINES = 60
const STREAM_PANE_ENV = 'CODEX_CLAUDE_STREAM_PANE'
const IDLE_TIMEOUT_ENV = 'CODEX_CLAUDE_IDLE_TIMEOUT_MS'
const HARD_TIMEOUT_ENV = 'CODEX_CLAUDE_HARD_TIMEOUT_MS'
const CLAUDE_HOME_ENV = 'CODEX_CLAUDE_HOME'
const QUESTION_PREFIX = 'QUESTION_FOR_CODEX:'
const CLAUDE_PROGRESS_LINE_PATTERN = /^\s*[✻✢✳✽✶·]\s+.{1,80}(?:…|\.{3})(?:\s+\([^)]*\))?\s*$/u

// CLI parsing and prompt construction

const readStdin = async () => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const readInput = async ({ prompt, promptFile }: {
  prompt?: string
  promptFile?: string
}) => {
  assertSingleTextInput({ left: prompt, leftLabel: '--prompt', right: promptFile, rightLabel: '--prompt-file' })
  return await readProvidedPrompt({ prompt, promptFile }) ?? await readStdin()
}

const readAnswer = async ({ answer, answerFile }: {
  answer?: string
  answerFile?: string
}) => {
  assertSingleTextInput({ left: answer, leftLabel: '--answer', right: answerFile, rightLabel: '--answer-file' })
  return await readProvidedPrompt({ prompt: answer, promptFile: answerFile }) ?? await readStdin()
}

const readProvidedPrompt = async ({ prompt, promptFile }: {
  prompt?: string
  promptFile?: string
}) => {
  if (prompt !== undefined) return prompt
  if (promptFile !== undefined) return readFile(promptFile, 'utf8')
  return null
}

const firstString = (...values: unknown[]) =>
  values.find((value): value is string => typeof value === 'string' && value.trim() !== '') || null

const claudeHomePath = () => process.env[CLAUDE_HOME_ENV] || join(homedir(), '.claude')

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

type SessionWatchdog = {
  markActivity: () => void
  commandTimeoutMs: () => number
  check: () => Promise<void>
  pollDelayMs: () => number
}

const waitUntil = async <T,>({ getValue, watchdog }: {
  getValue: () => Promise<T | null>
  watchdog: SessionWatchdog
}) => {
  while (true) {
    const value = await getValue()
    if (value !== null) return value
    await watchdog.check()
    await sleep(watchdog.pollDelayMs())
  }
}

export const isPaneStreamingEnabled = () => {
  const value = process.env[STREAM_PANE_ENV]?.toLowerCase()
  return value === undefined || !['0', 'false', 'off', 'no'].includes(value)
}

const commandTimeoutMs = (hardTimeoutAtMs?: number) => {
  if (hardTimeoutAtMs === undefined) return DEFAULT_COMMAND_TIMEOUT_MS
  const remaining = hardTimeoutAtMs - Date.now()
  if (remaining <= 0) throw new Error('Claude TUI adviser reached the configured hard timeout before producing a handoff.')
  return Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remaining)
}

export const buildClaudePrompt = ({ mode, input, cwd = process.cwd() }: {
  mode: Mode
  input: string
  cwd?: string
}) => {
  const trimmedInput = input.trim()
  const taskLabel = mode === 'review' ? 'review' : 'plan'
  const requestedOutput = mode === 'review'
    ? [
        'Return a concise code review with:',
        '- confirmed bugs, regressions, missing tests, or contract drift',
        '- uncertain findings clearly marked',
        '- no implementation edits',
      ].join('\n')
    : [
        'Return a concise implementation plan with:',
        '- recommended sequencing',
        '- relevant files and risks',
        '- validation steps',
        '- no implementation edits',
      ].join('\n')

  return [
    `You are advising Codex on a ${taskLabel}.`,
    '',
    'Codex remains responsible for validating your answer before presenting or acting on it.',
    'Inspect the repository as needed using read-only tools. Do not edit files.',
    'Work interactively with Codex. If you are blocked by missing requirements, ask exactly one clarification question.',
    `Start that question with ${QUESTION_PREFIX} and then wait for Codex to answer before continuing.`,
    'Do not use that prefix in your final answer.',
    '',
    `Repository: ${cwd}`,
    '',
    'Codex request:',
    trimmedInput === '' ? '(No additional prompt was provided.)' : trimmedInput,
    '',
    requestedOutput,
  ].join('\n')
}

export const parseArgs = (argv: string[]) => {
  const [mode, ...args] = argv
  if (!isMode(mode)) {
    throw new Error('Usage: claude-tui-adviser.mjs <plan|review> [--timeout-ms <milliseconds>] [--idle-timeout-ms <milliseconds>] [--hard-timeout-ms <milliseconds>] [--prompt <text> | --prompt-file <path> | --resume <state-path> (--answer <text> | --answer-file <path>)]')
  }

  return { mode, ...parseOptions(args) }
}

const isMode = (value: unknown): value is Mode => value === 'plan' || value === 'review'

const parseOptions = (args: string[]): Omit<ParsedArgs, 'mode'> => {
  const hardTimeoutMs = parseOptionalTimeoutMs(process.env[HARD_TIMEOUT_ENV], HARD_TIMEOUT_ENV)
  const parsed: Omit<ParsedArgs, 'mode'> = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: parseOptionalTimeoutMs(process.env[IDLE_TIMEOUT_ENV], IDLE_TIMEOUT_ENV) ?? DEFAULT_IDLE_TIMEOUT_MS,
  }
  if (hardTimeoutMs !== null) parsed.hardTimeoutMs = hardTimeoutMs

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    const value = optionValue({ args, index, option })
    applyOption({ parsed, option, value })
    index += 1
  }

  assertInputMode(parsed)

  return parsed
}

const optionValue = ({ args, index, option }: {
  args: string[]
  index: number
  option: string
}) => {
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${option} requires a value.`)
  return value
}

const applyOption = ({ parsed, option, value }: {
  parsed: Omit<ParsedArgs, 'mode'>
  option: string
  value: string
}) => {
  const optionHandlers: Record<string, () => void> = {
    '--timeout-ms': () => {
      parsed.timeoutMs = parseTimeoutMs(value, '--timeout-ms')
    },
    '--idle-timeout-ms': () => {
      parsed.idleTimeoutMs = parseTimeoutMs(value, '--idle-timeout-ms')
    },
    '--hard-timeout-ms': () => {
      parsed.hardTimeoutMs = parseTimeoutMs(value, '--hard-timeout-ms')
    },
    '--resume': () => {
      parsed.resumeFile = value
    },
    '--answer': () => {
      parsed.answer = value
    },
    '--answer-file': () => {
      parsed.answerFile = value
    },
    '--prompt': () => {
      parsed.prompt = value
    },
    '--prompt-file': () => {
      parsed.promptFile = value
    },
  }
  const handler = optionHandlers[option]
  if (handler === undefined) throw new Error(`Unknown option: ${option}`)
  handler()
}

const assertInputMode = (options: Omit<ParsedArgs, 'mode' | 'timeoutMs' | 'idleTimeoutMs' | 'hardTimeoutMs'>) => {
  const { answer, answerFile, prompt, promptFile } = options
  assertSingleTextInput({ left: prompt, leftLabel: '--prompt', right: promptFile, rightLabel: '--prompt-file' })
  assertSingleTextInput({ left: answer, leftLabel: '--answer', right: answerFile, rightLabel: '--answer-file' })
  assertAnswerRequiresResume(options)
  assertResumeExcludesPrompt(options)
}

const assertAnswerRequiresResume = ({ answer, answerFile, resumeFile }: Pick<ParsedArgs, 'answer' | 'answerFile' | 'resumeFile'>) => {
  if (resumeFile === undefined && (answer !== undefined || answerFile !== undefined)) {
    throw new Error('Use --answer or --answer-file only with --resume.')
  }
}

const assertResumeExcludesPrompt = ({ prompt, promptFile, resumeFile }: Pick<ParsedArgs, 'prompt' | 'promptFile' | 'resumeFile'>) => {
  if (resumeFile !== undefined && (prompt !== undefined || promptFile !== undefined)) {
    throw new Error('Use --resume with --answer or --answer-file, not --prompt or --prompt-file.')
  }
}

const assertSingleTextInput = ({ left, leftLabel, right, rightLabel }: {
  left?: string
  leftLabel: string
  right?: string
  rightLabel: string
}) => {
  if (left !== undefined && right !== undefined) throw new Error(`Use only one of ${leftLabel} or ${rightLabel}.`)
}

const parseTimeoutMs = (rawValue: string, label: string) => {
  const value = Number(rawValue)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number.`)
  return value
}

const parseOptionalTimeoutMs = (rawValue: string | undefined, label: string) =>
  rawValue === undefined || rawValue.trim() === '' ? null : parseTimeoutMs(rawValue, label)

// Command execution and tmux command builders

export const buildClaudeArgs = ({ mode, sessionId, settingsPath }: {
  mode: Mode
  sessionId: string
  settingsPath: string
}) => [
  ...(mode === 'plan' ? ['--permission-mode', 'plan'] : ['--model', REVIEW_MODEL]),
  '--tools',
  READ_ONLY_TOOLS,
  '--session-id',
  sessionId,
  '--settings',
  settingsPath,
]

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const shellJoin = (values: string[]) => values.map(shellQuote).join(' ')

export const buildTmuxStartInvocation = ({ cwd, mode, sessionId, sessionName, settingsPath }: {
  cwd: string
  mode: Mode
  sessionId: string
  sessionName: string
  settingsPath: string
}) => ({
  command: 'tmux',
  args: [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    cwd,
    shellJoin(['claude', ...buildClaudeArgs({ mode, sessionId, settingsPath })]),
  ],
})

export const buildTmuxPromptSubmissionInvocations = ({ bufferName, promptPath, sessionName }: {
  bufferName: string
  promptPath: string
  sessionName: string
}) => [
  {
    command: 'tmux',
    args: ['load-buffer', '-b', bufferName, promptPath],
  },
  {
    command: 'tmux',
    // Preserve multi-line prompts as one bracketed paste before sending Enter.
    args: ['paste-buffer', '-p', '-b', bufferName, '-t', sessionName],
  },
  {
    command: 'tmux',
    args: ['delete-buffer', '-b', bufferName],
  },
  {
    command: 'tmux',
    args: ['send-keys', '-t', sessionName, 'Enter'],
  },
]

const execCommand = async ({ command, args, cwd, input, timeoutMs = 30000 }: {
  command: string
  args: string[]
  cwd?: string
  input?: string
  timeoutMs?: number
}): Promise<CommandResult> => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const timeout = setTimeout(() => {
    child.kill('SIGTERM')
    rejectPromise(new Error(`${command} timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
  child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
  child.once('error', (error) => {
    clearTimeout(timeout)
    rejectPromise(error)
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timeout)
    const stdout = Buffer.concat(stdoutChunks).toString('utf8')
    const stderr = Buffer.concat(stderrChunks).toString('utf8')
    if (code === 0) {
      resolvePromise({ stdout, stderr })
      return
    }

    rejectPromise(new Error(`${command} exited with ${signal || code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
  })

  if (input === undefined) {
    child.stdin.end()
  } else {
    child.stdin.end(input)
  }
})

const assertRuntimeBinary = async ({ command, args, label, timeoutMs }: {
  command: string
  args: string[]
  label: string
  timeoutMs?: number
}) => {
  try {
    await execCommand({ command, args, timeoutMs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT/.test(message)) {
      throw new Error(`Claude TUI adviser requires ${label} on PATH.`)
    }

    throw new Error(`Claude TUI adviser could not run ${label}: ${message}`)
  }
}

// Runtime hook/settings file creation

const createRuntimeFiles = async (): Promise<RuntimeFiles> => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'codex-claude-tui-'))
  const eventLogPath = join(runtimeDir, 'events.jsonl')
  const hookPath = join(runtimeDir, 'hook.mjs')
  const promptPath = join(runtimeDir, 'prompt.txt')
  const settingsPath = join(runtimeDir, 'settings.json')
  const statePath = join(runtimeDir, 'session.json')

  await writeFile(hookPath, [
    "import { appendFileSync } from 'node:fs'",
    '',
    "const event = process.argv[2] || 'unknown'",
    "const chunks = []",
    "const parsePayload = (raw) => {",
    "  try { return JSON.parse(raw) } catch { return {} }",
    '}',
    "process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))",
    "process.stdin.on('end', () => {",
    "  const stdin = Buffer.concat(chunks).toString('utf8')",
    "  const payload = parsePayload(stdin)",
    "  const record = {",
    "    event,",
    "    at: new Date().toISOString(),",
    "    transcriptPath: payload.transcript_path,",
    "  }",
    "  if (process.env.CODEX_CLAUDE_DEBUG_HOOK_STDIN === '1') record.stdin = stdin",
    "  appendFileSync(process.env.CODEX_CLAUDE_EVENT_LOG, `${JSON.stringify(record)}\\n`)",
    '})',
    'process.stdin.resume()',
    '',
  ].join('\n'))

  const hookCommand = (event: string) =>
    `CODEX_CLAUDE_EVENT_LOG=${shellQuote(eventLogPath)} node ${shellQuote(hookPath)} ${shellQuote(event)}`
  const settings = {
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('SessionStart') }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('Stop') }] }],
    },
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

  return { eventLogPath, hookPath, promptPath, settingsPath, statePath, runtimeDir }
}

// Hook waiting and transcript reading

const readHookEvents = async (eventLogPath: string) => {
  try {
    const raw = await readFile(eventLogPath, 'utf8')
    return raw.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as HookEvent
      } catch {
        return { event: 'malformed' }
      }
    })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

const waitForHookEvent = async ({ event, eventLogPath, watchdog }: {
  event: 'SessionStart' | 'Stop'
  eventLogPath: string
  watchdog: SessionWatchdog
}) => {
  let seenEventCount = 0
  return waitUntil({
    watchdog,
    getValue: async () => {
      const events = await readHookEvents(eventLogPath)
      if (events.length > seenEventCount) {
        seenEventCount = events.length
        watchdog.markActivity()
      }
      return events.find((entry) => entry.event === event) || null
    },
  })
}

const waitForStopOrQuestion = async ({ cwd, eventLogPath, ignoredQuestion = '', sessionId, watchdog }: {
  cwd: string
  eventLogPath: string
  ignoredQuestion?: string
  sessionId: string
  watchdog: SessionWatchdog
}): Promise<StopOrQuestion> => {
  const state = { seenEventCount: 0, lastQuestion: ignoredQuestion }
  return waitUntil({
    watchdog,
    getValue: () => readStopOrQuestion({ cwd, eventLogPath, onActivity: watchdog.markActivity, sessionId, state }),
  })
}

const readStopOrQuestion = async ({ cwd, eventLogPath, onActivity, sessionId, state }: {
  cwd: string
  eventLogPath: string
  onActivity: () => void
  sessionId: string
  state: StopOrQuestionState
}): Promise<StopOrQuestion | null> => {
  const events = await readHookEvents(eventLogPath)
  recordHookActivity({ eventCount: events.length, onActivity, state })

  const stopEvent = events.find((entry) => entry.event === 'Stop')
  if (stopEvent !== undefined) return { kind: 'stop', stopEvent }

  return readNewQuestion({ cwd, onActivity, sessionId, state })
}

const recordHookActivity = ({ eventCount, onActivity, state }: {
  eventCount: number
  onActivity: () => void
  state: StopOrQuestionState
}) => {
  if (eventCount <= state.seenEventCount) return
  state.seenEventCount = eventCount
  onActivity()
}

const readNewQuestion = async ({ cwd, onActivity, sessionId, state }: {
  cwd: string
  onActivity: () => void
  sessionId: string
  state: StopOrQuestionState
}): Promise<StopOrQuestion | null> => {
  const question = await readTranscriptQuestionIfAvailable({ cwd, sessionId })
  if (question === null || question === state.lastQuestion) return null
  state.lastQuestion = question
  onActivity()
  return { kind: 'question', question }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

export const projectDirectoryName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

const fileExists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const deterministicTranscriptPaths = ({ cwd, sessionId, claudeHome }: {
  cwd: string
  sessionId: string
  claudeHome: string
}) => [
  join(claudeHome, 'projects', projectDirectoryName(cwd), `${sessionId}.jsonl`),
  join(claudeHome, 'transcripts', `${sessionId}.jsonl`),
]

const transcriptCandidatePaths = ({ claudeHome, cwd, sessionId, stopEvent }: {
  claudeHome: string
  cwd: string
  sessionId: string
  stopEvent: HookEvent
}) => [
  firstString(stopEvent.transcriptPath),
  ...deterministicTranscriptPaths({ cwd, sessionId, claudeHome }),
].filter((path): path is string => path !== null)

const firstExistingPath = async (paths: string[]) => {
  for (const path of paths) {
    if (await fileExists(path)) return path
  }

  return null
}

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toRecord = (value: unknown) => (isRecord(value) ? value : null)

const extractTextFromContent = (content: unknown) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const text = content
    .map((block) => {
      if (!isRecord(block)) return null
      return block.type === 'text' ? firstString(block.text) : null
    })
    .filter((value): value is string => value !== null)
    .join('\n')
    .trim()

  return text === '' ? null : text
}

const extractAssistantText = (entry: unknown) => {
  const record = toRecord(entry)
  return record === null ? null : extractAssistantRecordText(record)
}

const extractAssistantRecordText = (entry: Record<string, unknown>) => {
  const message = transcriptMessage(entry)
  if (!isAssistantEntry({ entry, message })) return null

  return extractTextFromContent(assistantContent({ entry, message }))
}

const transcriptMessage = (entry: Record<string, unknown>) => (isRecord(entry.message) ? entry.message : null)

const assistantContent = ({ entry, message }: {
  entry: Record<string, unknown>
  message: Record<string, unknown> | null
}) => (message === null ? entry.content : message.content)

const isAssistantEntry = ({ entry, message }: {
  entry: Record<string, unknown>
  message: Record<string, unknown> | null
}) => firstString(message?.role) === 'assistant' || firstString(entry.type) === 'assistant'

export const parseTranscriptAnswer = (raw: string) => {
  const lines = raw.split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const answer = extractAssistantText(parseJsonLine(lines[index]))
    if (answer !== null) return answer
  }

  return null
}

export const extractCodexQuestion = (text: string) => {
  const prefixIndex = text.lastIndexOf(QUESTION_PREFIX)
  if (prefixIndex === -1) return null
  const question = text.slice(prefixIndex + QUESTION_PREFIX.length).trim()
  return question === '' ? null : question
}

export const resolveClaudeTranscriptPath = async ({
  claudeHome = claudeHomePath(),
  cwd,
  sessionId,
  stopEvent,
}: {
  claudeHome?: string
  cwd: string
  sessionId: string
  stopEvent: HookEvent
}) => firstExistingPath(transcriptCandidatePaths({ claudeHome, cwd, sessionId, stopEvent }))

const waitForTranscriptAnswer = async ({ cwd, sessionId, stopEvent, watchdog }: {
  cwd: string
  sessionId: string
  stopEvent: HookEvent
  watchdog: SessionWatchdog
}) => {
  let lastTranscriptSignature = ''
  return waitUntil({
    watchdog,
    getValue: async () => {
      const result = await readTranscriptAnswerIfAvailable({ cwd, sessionId, stopEvent })
      if (result === null) return null
      if (result.signature !== lastTranscriptSignature) {
        lastTranscriptSignature = result.signature
        watchdog.markActivity()
      }
      return result.answer
    },
  })
}

const readTranscriptAnswerIfAvailable = async ({ cwd, sessionId, stopEvent }: {
  cwd: string
  sessionId: string
  stopEvent: HookEvent
}) => {
  const transcriptPath = await resolveClaudeTranscriptPath({ cwd, sessionId, stopEvent })
  if (transcriptPath === null) return null
  const signature = await fileActivitySignature(transcriptPath)
  if (signature === null) return null
  const answer = parseTranscriptAnswer(await readFile(transcriptPath, 'utf8'))
  return answer === null ? null : { answer, signature }
}

const readTranscriptQuestionIfAvailable = async ({ cwd, sessionId }: {
  cwd: string
  sessionId: string
}) => {
  const transcriptPath = await resolveClaudeTranscriptPath({ cwd, sessionId, stopEvent: { event: 'Stop' } })
  if (transcriptPath === null) return null
  const answer = parseTranscriptAnswer(await readFile(transcriptPath, 'utf8'))
  return answer === null ? null : extractCodexQuestion(answer)
}

// Session orchestration

export const buildHandoff = ({ answer, cwd, mode, sessionId }: {
  answer: string
  cwd: string
  mode: Mode
  sessionId: string
}) => ({
  ok: true,
  schemaVersion: 1,
  status: 'complete',
  mode,
  sessionId,
  cwd,
  createdAt: new Date().toISOString(),
  source: 'claude-tui',
  answer,
})

const buildQuestionHandoff = ({ cwd, mode, question, sessionId, sessionName, statePath }: {
  cwd: string
  mode: Mode
  question: string
  sessionId: string
  sessionName: string
  statePath: string
}) => ({
  ok: true,
  schemaVersion: 1,
  status: 'needs_input',
  mode,
  sessionId,
  cwd,
  createdAt: new Date().toISOString(),
  source: 'claude-tui',
  question,
  tmuxSession: sessionName,
  statePath,
  attachCommand: `tmux attach -t ${shellQuote(sessionName)}`,
  resumeCommand: `codex-claude-${mode} --resume ${shellQuote(statePath)} --answer ${shellQuote('<answer>')}`,
})

const sessionState = ({ cwd, mode, question, runtimeFiles, sessionId, sessionName }: {
  cwd: string
  mode: Mode
  question?: string
  runtimeFiles: RuntimeFiles
  sessionId: string
  sessionName: string
}): AdviserSessionState => ({
  schemaVersion: 1,
  cwd,
  mode,
  sessionId,
  sessionName,
  runtimeFiles,
  lastQuestion: question,
  createdAt: new Date().toISOString(),
})

const writeSessionState = async (state: AdviserSessionState) => {
  await writeFile(state.runtimeFiles.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

const readSessionState = async (statePath: string) => {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as AdviserSessionState
  if (state.schemaVersion !== 1) throw new Error(`Unsupported Claude TUI adviser session state at ${statePath}.`)
  return state
}

export const runAdviser = async ({
  cwd = process.cwd(),
  hardTimeoutMs,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  input,
  mode,
  timeoutMs,
}: {
  mode: Mode
  input: string
  timeoutMs: number
  idleTimeoutMs?: number
  hardTimeoutMs?: number
  cwd?: string
}) => {
  const hardTimeoutAtMs = hardTimeoutMs === undefined ? undefined : Date.now() + hardTimeoutMs
  let keepSession = false
  await assertRuntimeBinary({
    command: 'tmux',
    args: ['-V'],
    label: '`tmux`',
    timeoutMs: commandTimeoutMs(hardTimeoutAtMs),
  })
  await assertRuntimeBinary({
    command: 'claude',
    args: ['--version'],
    label: 'Claude Code CLI `claude`',
    timeoutMs: commandTimeoutMs(hardTimeoutAtMs),
  })

  const sessionId = randomUUID()
  const sessionName = `codex-claude-${sessionId.slice(0, 8)}`
  const prompt = buildClaudePrompt({ mode, input, cwd })
  const runtimeFiles = await createRuntimeFiles()
  await writeFile(runtimeFiles.promptPath, prompt, 'utf8')

  try {
    const result = await runAdviserSession({
      cwd,
      hardTimeoutMs,
      healthCheckIntervalMs: timeoutMs,
      idleTimeoutMs,
      mode,
      runtimeFiles,
      sessionId,
      sessionName,
    })
    keepSession = result.status === 'needs_input'
    return result
  } catch (error) {
    throw await appendTmuxPaneToError({ error, sessionName })
  } finally {
    if (!keepSession) {
      await killTmuxSession(sessionName)
      await cleanupRuntimeFiles(runtimeFiles.runtimeDir)
    }
  }
}

const runAdviserResume = async ({
  answer,
  hardTimeoutMs,
  idleTimeoutMs,
  mode,
  resumeFile,
  timeoutMs,
}: {
  answer: string
  hardTimeoutMs?: number
  idleTimeoutMs: number
  mode: Mode
  resumeFile: string
  timeoutMs: number
}) => {
  const state = await readSessionState(resumeFile)
  if (state.mode !== mode) throw new Error(`Claude TUI adviser session state is for ${state.mode}, not ${mode}.`)

  let keepSession = false
  try {
    const result = await resumeAdviserSession({
      answer,
      hardTimeoutMs,
      healthCheckIntervalMs: timeoutMs,
      idleTimeoutMs,
      state,
    })
    keepSession = result.status === 'needs_input'
    return result
  } catch (error) {
    throw await appendTmuxPaneToError({ error, sessionName: state.sessionName })
  } finally {
    if (!keepSession) {
      await killTmuxSession(state.sessionName)
      await cleanupRuntimeFiles(state.runtimeFiles.runtimeDir)
    }
  }
}

const captureTmuxPane = async (sessionName: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) => {
  try {
    const { stdout } = await execCommand({
      command: 'tmux',
      args: ['capture-pane', '-p', '-t', sessionName],
      timeoutMs,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

const createPaneStreamer = ({ onActivity, sessionName }: {
  sessionName: string
  onActivity?: () => void
}) => {
  if (!isPaneStreamingEnabled()) return { stop: () => undefined }

  let lastFingerprint = ''
  let lastStreamedAt = 0
  const streamPane = async () => {
    const snapshot = await capturePaneStreamSnapshot(sessionName)
    if (snapshot === null) return
    const now = Date.now()
    const fingerprint = paneStreamFingerprint(snapshot)
    recordPaneStreamActivity({ fingerprint, lastFingerprint, onActivity })
    if (!shouldStreamPane({ fingerprint, lastFingerprint, lastStreamedAt, now })) return
    lastFingerprint = fingerprint
    lastStreamedAt = now
    process.stderr.write(`\n[${sessionName} pane]\n${snapshot}\n`)
  }
  const interval = setInterval(() => {
    void streamPane()
  }, PANE_STREAM_POLL_MS)

  void streamPane()
  return {
    stop: () => clearInterval(interval),
  }
}

const capturePaneStreamSnapshot = async (sessionName: string) => {
  const pane = await captureTmuxPane(sessionName)
  return pane === null ? null : paneStreamSnapshot(pane)
}

const recordPaneStreamActivity = ({ fingerprint, lastFingerprint, onActivity }: {
  fingerprint: string
  lastFingerprint: string
  onActivity?: () => void
}) => {
  if (isNewPaneActivity({ fingerprint, lastFingerprint })) {
    onActivity?.()
  }
}

const isNewPaneActivity = ({ fingerprint, lastFingerprint }: {
  fingerprint: string
  lastFingerprint: string
}) => fingerprint !== '' && fingerprint !== lastFingerprint

const shouldStreamPane = ({ fingerprint, lastFingerprint, lastStreamedAt, now }: {
  fingerprint: string
  lastFingerprint: string
  lastStreamedAt: number
  now: number
}) => fingerprint !== lastFingerprint || now - lastStreamedAt >= PANE_STREAM_HEARTBEAT_MS

const inspectTmuxPaneState = async ({ sessionName, timeoutMs }: {
  sessionName: string
  timeoutMs: number
}) => {
  await assertTmuxSessionExists({ sessionName, timeoutMs })
  assertTmuxPaneIsAlive(await readTmuxPaneState({ sessionName, timeoutMs }))
}

const assertTmuxSessionExists = async ({ sessionName, timeoutMs }: {
  sessionName: string
  timeoutMs: number
}) => {
  try {
    await execCommand({ command: 'tmux', args: ['has-session', '-t', sessionName], timeoutMs })
  } catch {
    throw new Error('Claude TUI adviser tmux session disappeared before producing a handoff.')
  }
}

const readTmuxPaneState = async ({ sessionName, timeoutMs }: {
  sessionName: string
  timeoutMs: number
}) => {
  const { stdout } = await execCommand({
    command: 'tmux',
    args: ['display-message', '-p', '-t', sessionName, '#{pane_dead} #{pane_current_command}'],
    timeoutMs,
  })
  const [paneDead, currentCommand = ''] = stdout.trim().split(/\s+/)
  return { currentCommand, paneDead }
}

const assertTmuxPaneIsAlive = ({ paneDead }: {
  currentCommand: string
  paneDead: string
}) => {
  if (paneDead === '1') throw new Error('Claude TUI adviser Claude process exited before producing a handoff.')
}

const fileActivitySignature = async (path: string) => {
  try {
    const entry = await stat(path)
    return `${entry.size}:${entry.mtimeMs}`
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

const createSessionWatchdog = ({ cwd, hardTimeoutMs, healthCheckIntervalMs, idleTimeoutMs, sessionId, sessionName }: {
  cwd: string
  hardTimeoutMs?: number
  healthCheckIntervalMs: number
  idleTimeoutMs: number
  sessionId: string
  sessionName: string
}): SessionWatchdog => {
  const startedAtMs = Date.now()
  const hardTimeoutAtMs = hardTimeoutMs === undefined ? undefined : startedAtMs + hardTimeoutMs
  const activityCheckIntervalMs = Math.min(PANE_STREAM_POLL_MS, healthCheckIntervalMs)
  const transcriptStates = new Map<string, string>()
  let lastActivityAtMs = startedAtMs
  let lastPaneFingerprint = ''
  let nextActivityCheckAtMs = startedAtMs
  let nextHealthCheckAtMs = startedAtMs + healthCheckIntervalMs

  const markActivity = () => {
    lastActivityAtMs = Date.now()
  }

  const commandTimeout = () => commandTimeoutMs(hardTimeoutAtMs)

  const recordPaneActivity = async () => {
    const pane = await captureTmuxPane(sessionName, commandTimeout())
    if (pane === null) return
    const fingerprint = paneStreamFingerprint(paneStreamSnapshot(pane))
    if (fingerprint !== '' && fingerprint !== lastPaneFingerprint) markActivity()
    lastPaneFingerprint = fingerprint
  }

  const recordTranscriptActivity = async () => {
    const paths = deterministicTranscriptPaths({ cwd, sessionId, claudeHome: claudeHomePath() })
    for (const path of paths) {
      const signature = await fileActivitySignature(path)
      if (signature === null) continue
      const previousSignature = transcriptStates.get(path)
      if (previousSignature !== signature) markActivity()
      transcriptStates.set(path, signature)
    }
  }

  const inspectActivity = async () => {
    await inspectTmuxPaneState({ sessionName, timeoutMs: commandTimeout() })
    await recordPaneActivity()
    await recordTranscriptActivity()
  }

  const check = async () => {
    const now = Date.now()
    assertHardTimeout({ hardTimeoutAtMs, now })
    if (isDue({ nextAtMs: nextActivityCheckAtMs, now })) {
      await inspectActivity()
      nextActivityCheckAtMs = now + activityCheckIntervalMs
    }
    assertIdleTimeout({ idleTimeoutMs, lastActivityAtMs, now })
    if (isDue({ nextAtMs: nextHealthCheckAtMs, now })) {
      process.stderr.write('timeout elapsed but Claude is still active; continuing to wait\n')
      nextHealthCheckAtMs = now + healthCheckIntervalMs
    }
  }

  const pollDelayMs = () => {
    const now = Date.now()
    return Math.max(1, Math.min(
      HOOK_POLL_MS,
      nextActivityCheckAtMs - now,
      nextHealthCheckAtMs - now,
      lastActivityAtMs + idleTimeoutMs - now,
      hardTimeoutAtMs === undefined ? HOOK_POLL_MS : hardTimeoutAtMs - now,
    ))
  }

  return { check, commandTimeoutMs: commandTimeout, markActivity, pollDelayMs }
}

const isDue = ({ nextAtMs, now }: {
  nextAtMs: number
  now: number
}) => now >= nextAtMs

const assertHardTimeout = ({ hardTimeoutAtMs, now }: {
  hardTimeoutAtMs?: number
  now: number
}) => {
  if (hardTimeoutAtMs !== undefined && now >= hardTimeoutAtMs) {
    throw new Error('Claude TUI adviser reached the configured hard timeout before producing a handoff.')
  }
}

const assertIdleTimeout = ({ idleTimeoutMs, lastActivityAtMs, now }: {
  idleTimeoutMs: number
  lastActivityAtMs: number
  now: number
}) => {
  if (now - lastActivityAtMs >= idleTimeoutMs) {
    throw new Error(`Claude TUI adviser was idle for ${idleTimeoutMs}ms before producing a handoff.`)
  }
}

export const paneStreamSnapshot = (pane: string) => pane
  .split('\n')
  .slice(-PANE_STREAM_MAX_LINES)
  .join('\n')
  .trim()

export const paneStreamFingerprint = (pane: string) => pane
  .split('\n')
  .map(normalizePaneLineForStreaming)
  .filter((line) => line.trim() !== '')
  .join('\n')
  .trim()

const normalizePaneLineForStreaming = (line: string) => {
  if (CLAUDE_PROGRESS_LINE_PATTERN.test(line)) {
    return '<claude-progress>'
  }

  return line
    .replace(/\d+(?:\.\d+)?k tokens|\d+ tokens/g, '<tokens>')
    .replace(/(?:\d+m\s+)?\d+s(?=\s*(?:·|\)|$))/g, '<elapsed>')
}

const killTmuxSession = async (sessionName: string) => {
  try {
    await execCommand({ command: 'tmux', args: ['kill-session', '-t', sessionName] })
  } catch {
    // The Claude process may have exited and removed the tmux session already.
  }
}

const cleanupRuntimeFiles = async (runtimeDir: string) => {
  if (process.env.CODEX_CLAUDE_KEEP_RUNTIME_DIR === '1') return
  try {
    await rm(runtimeDir, { force: true, recursive: true })
  } catch {
    // Runtime directory cleanup is best-effort and must not mask the adviser result.
  }
}

const runAdviserSession = async ({
  cwd,
  hardTimeoutMs,
  healthCheckIntervalMs,
  idleTimeoutMs,
  mode,
  runtimeFiles,
  sessionId,
  sessionName,
}: {
  cwd: string
  hardTimeoutMs?: number
  healthCheckIntervalMs: number
  idleTimeoutMs: number
  mode: Mode
  runtimeFiles: RuntimeFiles
  sessionId: string
  sessionName: string
}) => {
  const watchdog = createSessionWatchdog({
    cwd,
    hardTimeoutMs,
    healthCheckIntervalMs,
    idleTimeoutMs,
    sessionId,
    sessionName,
  })
  const { command, args } = buildTmuxStartInvocation({
    cwd,
    mode,
    sessionId,
    sessionName,
    settingsPath: runtimeFiles.settingsPath,
  })
  await execCommand({ command, args, cwd, timeoutMs: watchdog.commandTimeoutMs() })
  const paneStreamer = createPaneStreamer({ onActivity: watchdog.markActivity, sessionName })
  try {
    await waitForHookEvent({ event: 'SessionStart', eventLogPath: runtimeFiles.eventLogPath, watchdog })
    await submitPromptToClaudeTui({ promptPath: runtimeFiles.promptPath, sessionName, watchdog })
    const result = await waitForStopOrQuestion({ cwd, eventLogPath: runtimeFiles.eventLogPath, sessionId, watchdog })
    if (result.kind === 'question') {
      await writeSessionState(sessionState({
        cwd,
        mode,
        question: result.question,
        runtimeFiles,
        sessionId,
        sessionName,
      }))
      return buildQuestionHandoff({
        cwd,
        mode,
        question: result.question,
        sessionId,
        sessionName,
        statePath: runtimeFiles.statePath,
      })
    }

    const answer = await waitForTranscriptAnswer({ cwd, sessionId, stopEvent: result.stopEvent, watchdog })
    return buildHandoff({ answer, cwd, mode, sessionId })
  } finally {
    paneStreamer.stop()
  }
}

const resumeAdviserSession = async ({ answer, hardTimeoutMs, healthCheckIntervalMs, idleTimeoutMs, state }: {
  answer: string
  hardTimeoutMs?: number
  healthCheckIntervalMs: number
  idleTimeoutMs: number
  state: AdviserSessionState
}) => {
  const watchdog = createSessionWatchdog({
    cwd: state.cwd,
    hardTimeoutMs,
    healthCheckIntervalMs,
    idleTimeoutMs,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
  })
  const paneStreamer = createPaneStreamer({ onActivity: watchdog.markActivity, sessionName: state.sessionName })
  try {
    await inspectTmuxPaneState({ sessionName: state.sessionName, timeoutMs: watchdog.commandTimeoutMs() })
    await writeFile(state.runtimeFiles.promptPath, buildClaudeAnswer(answer), 'utf8')
    await submitPromptToClaudeTui({
      promptPath: state.runtimeFiles.promptPath,
      sessionName: state.sessionName,
      watchdog,
    })
    const result = await waitForStopOrQuestion({
      cwd: state.cwd,
      eventLogPath: state.runtimeFiles.eventLogPath,
      ignoredQuestion: state.lastQuestion,
      sessionId: state.sessionId,
      watchdog,
    })
    if (result.kind === 'question') {
      await writeSessionState({ ...state, lastQuestion: result.question })
      return buildQuestionHandoff({
        cwd: state.cwd,
        mode: state.mode,
        question: result.question,
        sessionId: state.sessionId,
        sessionName: state.sessionName,
        statePath: state.runtimeFiles.statePath,
      })
    }

    const finalAnswer = await waitForTranscriptAnswer({
      cwd: state.cwd,
      sessionId: state.sessionId,
      stopEvent: result.stopEvent,
      watchdog,
    })
    return buildHandoff({ answer: finalAnswer, cwd: state.cwd, mode: state.mode, sessionId: state.sessionId })
  } finally {
    paneStreamer.stop()
  }
}

const buildClaudeAnswer = (answer: string) => [
  'Codex answer to your clarification question:',
  '',
  answer.trim() === '' ? '(No additional answer was provided.)' : answer.trim(),
].join('\n')

const submitPromptToClaudeTui = async ({ promptPath, sessionName, watchdog }: {
  promptPath: string
  sessionName: string
  watchdog: SessionWatchdog
}) => {
  const bufferName = `${sessionName}-prompt`
  for (const { command, args } of buildTmuxPromptSubmissionInvocations({ bufferName, promptPath, sessionName })) {
    await execCommand({ command, args, timeoutMs: watchdog.commandTimeoutMs() })
  }
}

const appendTmuxPaneToError = async ({ error, sessionName }: {
  error: unknown
  sessionName: string
}) => {
  const capturedPane = await captureTmuxPane(sessionName)
  const message = error instanceof Error ? error.message : String(error)
  return new Error(capturedPane === null ? message : `${message}\n\nLast tmux pane:\n${capturedPane}`)
}

// Error classification and CLI entrypoint

export const classifyLaunchFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const knownFailure = ([
    [/requires `?tmux`? on PATH|spawn tmux ENOENT/, 'Claude TUI adviser requires `tmux` on PATH.'],
    [/requires Claude Code CLI(?: `?claude`?)? on PATH|spawn claude ENOENT/, 'Claude TUI adviser requires `claude` on PATH.'],
    [/Please run \/login|Invalid authentication credentials/, 'Claude TUI adviser requires Claude authentication. Run `claude /login`.'],
    [/timed out waiting for (?:SessionStart|Stop)|timed out after|was idle|hard timeout|tmux session disappeared|Claude process exited/, 'Claude TUI adviser timed out before producing a handoff.'],
    [/could not find a final assistant answer/, 'Claude TUI adviser could not find a final assistant answer in the Claude transcript.'],
  ] satisfies [RegExp, string][]).find(([pattern]) => pattern.test(message))

  return knownFailure?.[1] || `Claude TUI adviser failed: ${message}`
}

const main = async () => {
  const { answer, answerFile, hardTimeoutMs, idleTimeoutMs, mode, prompt, promptFile, resumeFile, timeoutMs } = parseArgs(process.argv.slice(2))
  const handoff = resumeFile === undefined
    ? await runAdviser({
        hardTimeoutMs,
        idleTimeoutMs,
        mode,
        input: await readInput({ prompt, promptFile }),
        timeoutMs,
      })
    : await runAdviserResume({
        answer: await readAnswer({ answer, answerFile }),
        hardTimeoutMs,
        idleTimeoutMs,
        mode,
        resumeFile,
        timeoutMs,
      })
  process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(classifyLaunchFailure(error))
    process.exitCode = 1
  })
}
