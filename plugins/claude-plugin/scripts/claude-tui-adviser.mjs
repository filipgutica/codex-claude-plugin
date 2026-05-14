// fallow-ignore-file unused-file
// fallow-ignore-file unused-export
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const firstString = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '') || null

export const buildClaudePrompt = ({ mode, input, cwd = process.cwd() }) => {
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

export const parseArgs = (argv) => {
  const [mode, ...args] = argv
  if (!['plan', 'review'].includes(mode)) {
    throw new Error('Usage: claude-tui-adviser.mjs <plan|review> [--timeout-ms <milliseconds>]')
  }

  return { mode, timeoutMs: parseOptions(args) }
}

const parseOptions = (args) => {
  if (args.length === 0) return 300000
  if (args[0] !== '--timeout-ms') throw new Error(`Unknown option: ${args[0]}`)

  return parseTimeoutOptionValue(args)
}

const parseTimeoutOptionValue = (args) => {
  if (args[1] === undefined) {
    throw new Error('--timeout-ms requires a value.')
  }
  if (args.length > 2) throw new Error(`Unknown option: ${args[2]}`)

  return parseTimeoutMs(args[1])
}

const parseTimeoutMs = (rawValue) => {
  const value = Number(rawValue)
  if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout-ms must be a positive number.')
  return value
}

export const buildClaudePArgs = ({ prompt, sessionId, timeoutMs }) => [
  '--output-format',
  'json',
  '--timeout',
  String(Math.ceil(timeoutMs / 1000)),
  '--tools',
  'Read,Glob,Grep,LS',
  '--session-id',
  sessionId,
  prompt,
]

export const buildClaudePInvocation = ({ prompt, sessionId, timeoutMs }) => ({
  command: 'npx',
  args: ['-y', 'claude-p', ...buildClaudePArgs({ prompt, sessionId, timeoutMs })],
})

const parseJson = (raw) => {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`claude-p output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const parseClaudePResult = ({ raw, mode, sessionId, cwd = process.cwd() }) => {
  const parsed = parseJson(raw)
  const answer = firstString(parsed.result)

  if (parsed.is_error === true) {
    throw new Error(answer || 'claude-p reported an error.')
  }

  if (answer === null) {
    throw new Error('claude-p did not include an answer.')
  }

  return {
    ok: true,
    schemaVersion: 1,
    mode,
    sessionId: firstString(parsed.session_id, parsed.sessionId, sessionId),
    cwd,
    createdAt: new Date().toISOString(),
    source: 'claude-p',
    answer,
  }
}

const collectOutput = (stream) => {
  const chunks = []
  stream?.on('data', (chunk) => chunks.push(chunk))
  return () => Buffer.concat(chunks).toString('utf8')
}

export const classifyLaunchFailure = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  const knownFailure = [
    [/ENOENT/, 'Claude TUI adviser requires `npx` to run `claude-p`.'],
    [/timed out|exited with 124/, 'Claude TUI adviser timed out before producing a handoff.'],
  ].find(([pattern]) => pattern.test(message))

  return knownFailure?.[1] || `Claude TUI adviser failed: ${message}`
}

export const runAdviser = async ({ mode, input, timeoutMs, cwd = process.cwd() }) => {
  const sessionId = randomUUID()
  const prompt = buildClaudePrompt({ mode, input, cwd })
  const { command, args } = buildClaudePInvocation({ prompt, sessionId, timeoutMs })
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const readStdout = collectOutput(child.stdout)
  const readStderr = collectOutput(child.stderr)

  await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      const suffix = readStderr().trim()
      rejectPromise(new Error(`npx claude-p exited with ${signal || code}${suffix ? `: ${suffix}` : ''}`))
    })
  })

  return parseClaudePResult({ raw: readStdout(), mode, sessionId, cwd })
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
