// fallow-ignore-file unused-file
// fallow-ignore-file code-duplication
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Mode = 'plan' | 'review'

type RuntimeFiles = {
  eventLogPath: string
  hookPath: string
  settingsPath: string
  runtimeDir: string
}

type CommandResult = {
  stdout: string
  stderr: string
}

type HookEvent = {
  event: unknown
  at?: unknown
  transcriptPath?: string
  lastAssistantMessage?: string
}

const READ_ONLY_TOOLS = 'Read,Glob,Grep,LS'
const DEFAULT_TIMEOUT_MS = 300000
const HOOK_POLL_MS = 250
const FALLBACK_TRANSCRIPT_SCAN_MS = 1000

const readStdin = async () => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const firstString = (...values: unknown[]) =>
  values.find((value): value is string => typeof value === 'string' && value.trim() !== '') || null

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const remainingTimeoutMs = (deadlineMs: number) => {
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) throw new Error('Claude TUI adviser timed out before producing a handoff.')
  return remaining
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
    throw new Error('Usage: claude-tui-adviser.mjs <plan|review> [--timeout-ms <milliseconds>]')
  }

  return { mode, timeoutMs: parseOptions(args) }
}

const isMode = (value: unknown): value is Mode => value === 'plan' || value === 'review'

const parseOptions = (args: string[]) => {
  if (args.length === 0) return DEFAULT_TIMEOUT_MS
  if (args[0] !== '--timeout-ms') throw new Error(`Unknown option: ${args[0]}`)

  return parseTimeoutOptionValue(args)
}

const parseTimeoutOptionValue = (args: string[]) => {
  if (args[1] === undefined) {
    throw new Error('--timeout-ms requires a value.')
  }
  if (args.length > 2) throw new Error(`Unknown option: ${args[2]}`)

  return parseTimeoutMs(args[1])
}

const parseTimeoutMs = (rawValue: string) => {
  const value = Number(rawValue)
  if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout-ms must be a positive number.')
  return value
}

export const buildClaudeArgs = ({ prompt, sessionId, settingsPath }: {
  prompt: string
  sessionId: string
  settingsPath: string
}) => [
  '--permission-mode',
  'plan',
  '--tools',
  READ_ONLY_TOOLS,
  '--session-id',
  sessionId,
  '--settings',
  settingsPath,
  prompt,
]

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const shellJoin = (values: string[]) => values.map(shellQuote).join(' ')

export const buildTmuxStartInvocation = ({ cwd, prompt, sessionId, sessionName, settingsPath }: {
  cwd: string
  prompt: string
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
    shellJoin(['claude', ...buildClaudeArgs({ prompt, sessionId, settingsPath })]),
  ],
})

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

const assertRuntimeBinary = async ({ command, args, label }: {
  command: string
  args: string[]
  label: string
}) => {
  try {
    await execCommand({ command, args })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT/.test(message)) {
      throw new Error(`Claude TUI adviser requires ${label} on PATH.`)
    }

    throw new Error(`Claude TUI adviser could not run ${label}: ${message}`)
  }
}

const createRuntimeFiles = async (): Promise<RuntimeFiles> => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'codex-claude-tui-'))
  const eventLogPath = join(runtimeDir, 'events.jsonl')
  const hookPath = join(runtimeDir, 'hook.mjs')
  const settingsPath = join(runtimeDir, 'settings.json')

  await writeFile(hookPath, [
    "import { appendFileSync } from 'node:fs'",
    '',
    "const event = process.argv[2] || 'unknown'",
    "const chunks = []",
    "process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))",
    "process.stdin.on('end', () => {",
    "  const stdin = Buffer.concat(chunks).toString('utf8')",
    "  const payload = parsePayload(stdin)",
    "  const record = {",
    "    event,",
    "    at: new Date().toISOString(),",
    "    transcriptPath: payload.transcript_path,",
    "    lastAssistantMessage: payload.last_assistant_message,",
    "  }",
    "  if (process.env.CODEX_CLAUDE_DEBUG_HOOK_STDIN === '1') record.stdin = stdin",
    "  appendFileSync(process.env.CODEX_CLAUDE_EVENT_LOG, `${JSON.stringify(record)}\\n`)",
    '})',
    "const parsePayload = (raw) => {",
    "  try { return JSON.parse(raw) } catch { return {} }",
    '}',
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

  return { eventLogPath, hookPath, settingsPath, runtimeDir }
}

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

const waitForHookEvent = async ({ deadlineMs, event, eventLogPath }: {
  deadlineMs: number
  event: 'SessionStart' | 'Stop'
  eventLogPath: string
}) => {
  while (Date.now() < deadlineMs) {
    const events = await readHookEvents(eventLogPath)
    const matchedEvent = events.find((entry) => entry.event === event)
    if (matchedEvent !== undefined) return matchedEvent
    await sleep(Math.min(HOOK_POLL_MS, Math.max(1, deadlineMs - Date.now())))
  }

  throw new Error(`Claude TUI adviser timed out waiting for ${event}.`)
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

const collectJsonlFiles = async ({ root, maxFiles = 5000 }: {
  root: string
  maxFiles?: number
}) => {
  const files: string[] = []
  const pendingDirs = [root]

  while (pendingDirs.length > 0 && files.length < maxFiles) {
    const dir = pendingDirs.pop()
    if (dir !== undefined) {
      addJsonlPaths({
        dir,
        entries: await readDirectoryEntries(dir),
        files,
        maxFiles,
        pendingDirs,
      })
    }
  }

  return files
}

const addJsonlPaths = ({ dir, entries, files, maxFiles, pendingDirs }: {
  dir: string
  entries: Awaited<ReturnType<typeof readDirectoryEntries>>
  files: string[]
  maxFiles: number
  pendingDirs: string[]
}) => {
  for (const entry of entries) {
    if (files.length >= maxFiles) return
    addJsonlPath({ dir, entry, files, pendingDirs })
  }
}

const addJsonlPath = ({ dir, entry, files, pendingDirs }: {
  dir: string
  entry: Awaited<ReturnType<typeof readDirectoryEntries>>[number]
  files: string[]
  pendingDirs: string[]
}) => {
  const path = join(dir, entry.name)
  if (entry.isDirectory()) {
    pendingDirs.push(path)
    return
  }

  if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
}

const readDirectoryEntries = async (dir: string) => {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

export const findDirectClaudeTranscriptPath = async ({ cwd, sessionId, claudeHome = join(homedir(), '.claude') }: {
  cwd: string
  sessionId: string
  claudeHome?: string
}) => {
  const directProjectPath = join(claudeHome, 'projects', projectDirectoryName(cwd), `${sessionId}.jsonl`)
  if (await fileExists(directProjectPath)) return directProjectPath

  const directTranscriptPath = join(claudeHome, 'transcripts', `${sessionId}.jsonl`)
  if (await fileExists(directTranscriptPath)) return directTranscriptPath

  return null
}

export const findClaudeTranscriptPath = async ({ cwd, sessionId, claudeHome = join(homedir(), '.claude') }: {
  cwd: string
  sessionId: string
  claudeHome?: string
}) => {
  const directPath = await findDirectClaudeTranscriptPath({ cwd, sessionId, claudeHome })
  if (directPath !== null) return directPath

  const projectFiles = await collectJsonlFiles({ root: join(claudeHome, 'projects') })
  return projectFiles.find((path) => path.endsWith(`/${sessionId}.jsonl`)) || null
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

const waitForTranscriptAnswer = async ({ cwd, deadlineMs, sessionId, stopEvent }: {
  cwd: string
  deadlineMs: number
  sessionId: string
  stopEvent: HookEvent
}) => {
  const stopAnswer = firstString(stopEvent.lastAssistantMessage)
  if (stopAnswer !== null) return stopAnswer

  return waitForTranscriptFallback({ cwd, deadlineMs, sessionId, stopEvent })
}

const waitForTranscriptFallback = async ({ cwd, deadlineMs, sessionId, stopEvent }: {
  cwd: string
  deadlineMs: number
  sessionId: string
  stopEvent: HookEvent
}) => {
  const fallbackScanAt = Date.now() + FALLBACK_TRANSCRIPT_SCAN_MS
  while (Date.now() < deadlineMs) {
    const transcriptPath = await findTranscriptPathForPoll({ cwd, fallbackScanAt, sessionId, stopEvent })
    if (transcriptPath !== null) {
      const answer = parseTranscriptAnswer(await readFile(transcriptPath, 'utf8'))
      if (answer !== null) return answer
    }

    await sleep(Math.min(HOOK_POLL_MS, Math.max(1, deadlineMs - Date.now())))
  }

  throw new Error('Claude TUI adviser could not find a final assistant answer in the Claude transcript.')
}

const findTranscriptPathForPoll = async ({ cwd, fallbackScanAt, sessionId, stopEvent }: {
  cwd: string
  fallbackScanAt: number
  sessionId: string
  stopEvent: HookEvent
}) => {
  const stopTranscriptPath = await existingStopTranscriptPath(stopEvent)
  if (stopTranscriptPath !== null) return stopTranscriptPath

  const directPath = await findDirectClaudeTranscriptPath({ cwd, sessionId })
  if (directPath !== null) return directPath

  return Date.now() >= fallbackScanAt ? findClaudeTranscriptPath({ cwd, sessionId }) : null
}

const existingStopTranscriptPath = async (stopEvent: HookEvent) => {
  const stopTranscriptPath = firstString(stopEvent.transcriptPath)
  if (stopTranscriptPath === null) return null
  return await fileExists(stopTranscriptPath) ? stopTranscriptPath : null
}

const captureTmuxPane = async (sessionName: string) => {
  try {
    const { stdout } = await execCommand({
      command: 'tmux',
      args: ['capture-pane', '-p', '-t', sessionName],
    })
    return stdout.trim()
  } catch {
    return null
  }
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

export const buildHandoff = ({ answer, cwd, mode, sessionId }: {
  answer: string
  cwd: string
  mode: Mode
  sessionId: string
}) => ({
  ok: true,
  schemaVersion: 1,
  mode,
  sessionId,
  cwd,
  createdAt: new Date().toISOString(),
  source: 'claude-tui',
  answer,
})

export const classifyLaunchFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const knownFailure = ([
    [/requires tmux on PATH|spawn tmux ENOENT/, 'Claude TUI adviser requires `tmux` on PATH.'],
    [/requires Claude Code CLI on PATH|spawn claude ENOENT/, 'Claude TUI adviser requires `claude` on PATH.'],
    [/timed out waiting for Stop|timed out after/, 'Claude TUI adviser timed out before producing a handoff.'],
    [/could not find a final assistant answer/, 'Claude TUI adviser could not find a final assistant answer in the Claude transcript.'],
  ] satisfies [RegExp, string][]).find(([pattern]) => pattern.test(message))

  return knownFailure?.[1] || `Claude TUI adviser failed: ${message}`
}

export const runAdviser = async ({ mode, input, timeoutMs, cwd = process.cwd() }: {
  mode: Mode
  input: string
  timeoutMs: number
  cwd?: string
}) => {
  const deadlineMs = Date.now() + timeoutMs
  await assertRuntimeBinary({ command: 'tmux', args: ['-V'], label: '`tmux`' })
  await assertRuntimeBinary({ command: 'claude', args: ['--version'], label: 'Claude Code CLI `claude`' })

  const sessionId = randomUUID()
  const sessionName = `codex-claude-${sessionId.slice(0, 8)}`
  const prompt = buildClaudePrompt({ mode, input, cwd })
  const runtimeFiles = await createRuntimeFiles()

  try {
    return await runAdviserSession({ cwd, deadlineMs, mode, prompt, runtimeFiles, sessionId, sessionName })
  } catch (error) {
    throw await appendTmuxPaneToError({ error, sessionName })
  } finally {
    await killTmuxSession(sessionName)
    await cleanupRuntimeFiles(runtimeFiles.runtimeDir)
  }
}

const runAdviserSession = async ({ cwd, deadlineMs, mode, prompt, runtimeFiles, sessionId, sessionName }: {
  cwd: string
  deadlineMs: number
  mode: Mode
  prompt: string
  runtimeFiles: RuntimeFiles
  sessionId: string
  sessionName: string
}) => {
  const { command, args } = buildTmuxStartInvocation({
    cwd,
    prompt,
    sessionId,
    sessionName,
    settingsPath: runtimeFiles.settingsPath,
  })
  await execCommand({ command, args, cwd, timeoutMs: remainingTimeoutMs(deadlineMs) })
  await waitForHookEvent({ deadlineMs, event: 'SessionStart', eventLogPath: runtimeFiles.eventLogPath })
  const stopEvent = await waitForHookEvent({ deadlineMs, event: 'Stop', eventLogPath: runtimeFiles.eventLogPath })
  const answer = await waitForTranscriptAnswer({ cwd, deadlineMs, sessionId, stopEvent })
  return buildHandoff({ answer, cwd, mode, sessionId })
}

const appendTmuxPaneToError = async ({ error, sessionName }: {
  error: unknown
  sessionName: string
}) => {
  const capturedPane = await captureTmuxPane(sessionName)
  const message = error instanceof Error ? error.message : String(error)
  return new Error(capturedPane === null ? message : `${message}\n\nLast tmux pane:\n${capturedPane}`)
}

const main = async () => {
  const { mode, timeoutMs } = parseArgs(process.argv.slice(2))
  const input = await readStdin()
  const handoff = await runAdviser({ mode, input, timeoutMs })
  process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(classifyLaunchFailure(error))
    process.exitCode = 1
  })
}
