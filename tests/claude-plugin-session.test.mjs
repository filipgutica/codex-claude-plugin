// fallow-ignore-file unused-file
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

const runtime = await import('../plugins/claude-plugin/scripts/claude-tui-adviser.mjs')
const SINGLE_QUOTED_ARGS = {
  sessionId: /'--session-id' '([^']+)'/,
  settings: /'--settings' '([^']+)'/,
}
const FAKE_QUESTION = 'Which files should I inspect first?'
const FAKE_QUESTION_LINE = `QUESTION_FOR_CODEX: ${FAKE_QUESTION}`

const createChildProcess = ({ code = 0, stdout = '', stderr = '' } = {}) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = vi.fn()

  queueMicrotask(() => {
    if (stdout !== '') child.stdout.write(stdout)
    if (stderr !== '') child.stderr.write(stderr)
    child.stdout.end()
    child.stderr.end()
    child.emit('exit', code, null)
  })

  return child
}

const parseSettingsPath = (args) => {
  return parseSingleQuotedArg({ args, label: 'settings path', pattern: SINGLE_QUOTED_ARGS.settings })
}

const parseEventLogPath = (settingsPath) => {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const command = settings.hooks.SessionStart[0].hooks[0].command
  const match = command.match(/CODEX_CLAUDE_EVENT_LOG='([^']+)'/)
  if (match === null) throw new Error(`Could not parse event log path from ${command}`)
  return match[1]
}

const parseTmuxCwd = (args) => {
  const cwdFlag = args.indexOf('-c')
  if (cwdFlag === -1 || args[cwdFlag + 1] === undefined) throw new Error(`Could not parse cwd from ${args.join(' ')}`)
  return args[cwdFlag + 1]
}

const parseSessionId = (args) => {
  return parseSingleQuotedArg({ args, label: 'session id', pattern: SINGLE_QUOTED_ARGS.sessionId })
}

const parseSingleQuotedArg = ({ args, label, pattern }) => {
  const command = args.at(-1)
  const match = typeof command === 'string' ? command.match(pattern) : null
  if (match === null) throw new Error(`Could not parse ${label} from ${String(command)}`)
  return match[1]
}

const writeHookEvent = ({ eventLogPath, event, transcriptPath }) => {
  const record = { event, at: new Date().toISOString(), transcriptPath }
  writeFileSync(eventLogPath, `${JSON.stringify(record)}\n`, { flag: 'a' })
}

const installFakeRuntime = ({
  handoffDelayMs = 60,
  paneOutputs = ['Reading files'],
  promptRequiresRetry = false,
  questionDelayMs,
  questionStopDelayMs,
} = {}) => {
  const state = {
    buffer: '',
    cwd: '',
    enterCount: 0,
    eventLogPath: '',
    paneIndex: 0,
    paneOutputs,
    promptRequiresRetry,
    promptVisible: false,
    sessionId: '',
    transcriptPath: '',
  }
  spawnMock.mockImplementation((command, args) => {
    const childProcess = fakeRuntimeCommand({ args, command, handoffDelayMs, questionDelayMs, questionStopDelayMs, state })
    if (childProcess !== null) return childProcess
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  })
  return state
}

const fakeRuntimeCommand = ({ args, command, handoffDelayMs, questionDelayMs, questionStopDelayMs, state }) => {
  if (command === 'claude') return fakeClaudeCommand(args)
  if (command === 'tmux') return fakeTmuxCommand({ args, handoffDelayMs, questionDelayMs, questionStopDelayMs, state })
  return null
}

const fakeClaudeCommand = (args) =>
  args[0] === '--version' ? createChildProcess({ stdout: '2.1.142\n' }) : null

const fakeTmuxCommand = ({ args, handoffDelayMs, questionDelayMs, questionStopDelayMs, state }) => {
  const handler = fakeTmuxHandlers[args[0]] ?? (() => createChildProcess())
  return handler({ args, handoffDelayMs, questionDelayMs, questionStopDelayMs, state })
}

const fakeTmuxHandlers = {
  '-V': () => createChildProcess({ stdout: 'tmux 3.4\n' }),
  'capture-pane': ({ state }) => captureFakePane(state),
  'delete-buffer': () => createChildProcess(),
  'display-message': () => createChildProcess({ stdout: '0 claude\n' }),
  'load-buffer': ({ args, state }) => loadFakeBuffer({ args, state }),
  'new-session': (options) => startFakeTmuxSession(options),
  'paste-buffer': ({ state }) => pasteFakeBuffer(state),
  'send-keys': ({ args, state }) => sendFakeKeys({ args, state }),
}

const startFakeTmuxSession = ({ args, handoffDelayMs, questionDelayMs, questionStopDelayMs, state }) => {
  state.cwd = parseTmuxCwd(args)
  state.sessionId = parseSessionId(args)
  const settingsPath = parseSettingsPath(args)
  state.eventLogPath = parseEventLogPath(settingsPath)
  state.transcriptPath = join(dirname(state.eventLogPath), 'transcript.jsonl')
  writeHookEvent({ eventLogPath: state.eventLogPath, event: 'SessionStart' })
  if (questionDelayMs === undefined) {
    setTimeout(() => writeFakeHandoff(state), handoffDelayMs)
  } else {
    setTimeout(() => writeFakeQuestion(state), questionDelayMs)
    if (questionStopDelayMs !== undefined) {
      setTimeout(() => writeFakeQuestionStop(state), questionStopDelayMs)
    }
  }
  return createChildProcess()
}

const loadFakeBuffer = ({ args, state }) => {
  state.buffer = readFileSync(args.at(-1), 'utf8')
  return createChildProcess()
}

const pasteFakeBuffer = (state) => {
  state.promptVisible = true
  return createChildProcess()
}

const sendFakeKeys = ({ args, state }) => {
  if (args.includes('Enter')) {
    state.enterCount += 1
    if (!state.promptRequiresRetry || state.enterCount > 1) state.promptVisible = false
  }
  return createChildProcess()
}

const captureFakePane = (state) => {
  const stdout = state.promptVisible
    ? state.buffer
    : state.paneOutputs[Math.min(state.paneIndex, state.paneOutputs.length - 1)]
  state.paneIndex += 1
  return createChildProcess({ stdout: `${stdout}\n` })
}

const writeFakeHandoff = ({ eventLogPath, transcriptPath }) => {
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Keep waiting.' }] },
  })}\n`)
  writeHookEvent({ eventLogPath, event: 'Stop', transcriptPath })
}

const writeFakeQuestion = ({ cwd, sessionId }) => {
  const claudeHome = process.env.CODEX_CLAUDE_HOME
  if (claudeHome === undefined) throw new Error('CODEX_CLAUDE_HOME is required for fake question transcripts')
  const transcriptPath = join(claudeHome, 'projects', runtime.projectDirectoryName(cwd), `${sessionId}.jsonl`)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: FAKE_QUESTION_LINE }],
    },
  })}\n`)
}

const writeFakeQuestionStop = ({ cwd, eventLogPath, sessionId }) => {
  const claudeHome = process.env.CODEX_CLAUDE_HOME
  if (claudeHome === undefined) throw new Error('CODEX_CLAUDE_HOME is required for fake question transcripts')
  const transcriptPath = join(claudeHome, 'projects', runtime.projectDirectoryName(cwd), `${sessionId}.jsonl`)
  writeHookEvent({ eventLogPath, event: 'Stop', transcriptPath })
}

const expectCompletedReviewHandoff = (handoff) => {
  expect(handoff).toMatchObject({
    ok: true,
    schemaVersion: 1,
    mode: 'review',
    cwd: '/repo',
    source: 'claude-tui',
    answer: 'Keep waiting.',
  })
}

const expectNeedsInputQuestionHandoff = (handoff) => {
  expect(handoff).toMatchObject({
    ok: true,
    schemaVersion: 1,
    status: 'needs_input',
    mode: 'plan',
    question: FAKE_QUESTION,
  })
}

const expectContinuingLog = (stderrWrite) => {
  expect(stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
    'Claude is still running; continuing to wait for the handoff',
  )
}

const runFakeReviewAdviser = () => runtime.runAdviser({
  mode: 'review',
  input: 'Review current changes.',
  timeoutMs: 20,
  idleTimeoutMs: 200,
  cwd: '/repo',
})

const runFakePlanAdviser = () => runtime.runAdviser({
  mode: 'plan',
  input: 'Plan the implementation.',
  timeoutMs: 100,
  idleTimeoutMs: 500,
  cwd: '/repo',
})

const cleanupFakeClaudeHome = ({ claudeHome, statePath }) => {
  if (typeof statePath === 'string') rmSync(dirname(statePath), { force: true, recursive: true })
  rmSync(claudeHome, { force: true, recursive: true })
  delete process.env.CODEX_CLAUDE_HOME
}

const expectReviewRun = async ({ enterCount, runtimeOptions, shouldLogContinuing = false }) => {
  const state = installFakeRuntime(runtimeOptions)
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  try {
    const handoff = await runFakeReviewAdviser()

    expectCompletedReviewHandoff(handoff)
    expect(state.enterCount).toBe(enterCount)
    if (shouldLogContinuing) expectContinuingLog(stderrWrite)
  } finally {
    stderrWrite.mockRestore()
  }
}

const expectPlanQuestionRun = async ({ expectSessionMetadata = false, runtimeOptions }) => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'codex-claude-home-'))
  let statePath = null
  process.env.CODEX_CLAUDE_HOME = claudeHome
  installFakeRuntime(runtimeOptions)
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  try {
    const handoff = await runFakePlanAdviser()

    statePath = handoff.statePath
    expectNeedsInputQuestionHandoff(handoff)
    if (expectSessionMetadata) {
      expect(handoff).toMatchObject({ cwd: '/repo', source: 'claude-tui' })
      expect(handoff.attachCommand).toContain('tmux attach -t')
      expect(handoff.resumeCommand).toContain('codex-claude-plan --resume')
      expect(JSON.parse(readFileSync(handoff.statePath, 'utf8'))).toMatchObject({
        mode: 'plan',
        cwd: '/repo',
        lastQuestion: FAKE_QUESTION,
      })
    }
  } finally {
    stderrWrite.mockRestore()
    cleanupFakeClaudeHome({ claudeHome, statePath })
  }
}

describe('Claude session orchestration', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    delete process.env.CODEX_CLAUDE_HOME
    delete process.env.CODEX_CLAUDE_IDLE_TIMEOUT_MS
    delete process.env.CODEX_CLAUDE_HARD_TIMEOUT_MS
  })

  it('continues past the health-check timeout while Claude has recent pane activity', async () => {
    await expectReviewRun({
      enterCount: 1,
      runtimeOptions: {
        handoffDelayMs: 70,
        paneOutputs: [
          'Reading files',
          'Inspecting src/runtime.ts',
          'Writing review',
        ],
      },
      shouldLogContinuing: true,
    })
  })

  it('resends Enter when the pasted prompt remains visible in the Claude input', async () => {
    await expectReviewRun({
      enterCount: 2,
      runtimeOptions: {
        handoffDelayMs: 70,
        paneOutputs: ['Reading files'],
        promptRequiresRetry: true,
      },
    })
  })

  it('continues waiting when a live Claude pane has no detectable activity', async () => {
    installFakeRuntime({
      handoffDelayMs: 70,
      paneOutputs: ['✳ Churning... (1m 3s · ↓ 1.8k tokens · almost done thinking with high effort)'],
    })
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const handoff = await runtime.runAdviser({
        mode: 'review',
        input: 'Review current changes.',
        timeoutMs: 20,
        idleTimeoutMs: 30,
        cwd: '/repo',
      })

      expectCompletedReviewHandoff(handoff)
      expectContinuingLog(stderrWrite)
    } finally {
      stderrWrite.mockRestore()
    }
  })

  it('fails when Claude remains live past an explicit hard timeout', async () => {
    installFakeRuntime({
      handoffDelayMs: 200,
      paneOutputs: ['✳ Churning... (1m 3s · ↓ 1.8k tokens · almost done thinking with high effort)'],
    })
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await expect(runtime.runAdviser({
        mode: 'review',
        input: 'Review current changes.',
        timeoutMs: 20,
        idleTimeoutMs: 30,
        hardTimeoutMs: 50,
        cwd: '/repo',
      })).rejects.toThrow('Claude TUI adviser reached the configured hard timeout before producing a handoff.')
    } finally {
      stderrWrite.mockRestore()
    }
  })

  it('returns a needs-input handoff and keeps session state when Claude asks Codex a question', async () => {
    await expectPlanQuestionRun({
      expectSessionMetadata: true,
      runtimeOptions: {
        questionDelayMs: 20,
        paneOutputs: [
          'Reading the request',
          FAKE_QUESTION_LINE,
        ],
      },
    })
  })

  it('prefers a fresh Claude question over a Stop hook from the same turn', async () => {
    await expectPlanQuestionRun({
      runtimeOptions: {
        questionDelayMs: 10,
        questionStopDelayMs: 20,
        paneOutputs: [FAKE_QUESTION_LINE],
      },
    })
  })
})
