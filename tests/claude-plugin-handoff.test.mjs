// fallow-ignore-file unused-file
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildClaudeArgs,
  buildClaudePrompt,
  buildHandoff,
  buildTmuxPromptSubmissionInvocations,
  buildTmuxStartInvocation,
  classifyLaunchFailure,
  findDirectClaudeTranscriptPath,
  findClaudeTranscriptPath,
  parseArgs,
  parseTranscriptAnswer,
  projectDirectoryName,
} from '../plugins/claude-plugin/scripts/claude-tui-adviser.mjs'

describe('claude tui adviser prompt and args', () => {
  it('builds a plan prompt that keeps Claude advisory and read-only', () => {
    const prompt = buildClaudePrompt({
      mode: 'plan',
      input: 'Add the local Claude TUI handoff flow.',
      cwd: '/repo',
    })

    expect(prompt).toContain('advising Codex on a plan')
    expect(prompt).toContain('Codex remains responsible')
    expect(prompt).toContain('Do not edit files')
    expect(prompt).toContain('Add the local Claude TUI handoff flow.')
  })

  it('builds a review prompt with review-specific output guidance', () => {
    const prompt = buildClaudePrompt({
      mode: 'review',
      input: 'Review current changes.',
      cwd: '/repo',
    })

    expect(prompt).toContain('advising Codex on a review')
    expect(prompt).toContain('confirmed bugs, regressions, missing tests, or contract drift')
    expect(prompt).toContain('Review current changes.')
  })

  it('builds Claude TUI args for plan mode and a read-only tool set', () => {
    expect(
      buildClaudeArgs({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        settingsPath: '/tmp/settings.json',
      }),
    ).toEqual([
      '--permission-mode',
      'plan',
      '--tools',
      'Read,Glob,Grep,LS',
      '--session-id',
      '123e4567-e89b-12d3-a456-426614174000',
      '--settings',
      '/tmp/settings.json',
    ])
  })

  it('builds a tmux invocation for the local Claude TUI runtime', () => {
    const invocation = buildTmuxStartInvocation({
      cwd: '/repo',
      sessionId: 'session-1',
      sessionName: 'codex-claude-session',
      settingsPath: '/tmp/settings.json',
    })

    expect(invocation.command).toBe('tmux')
    expect(invocation.args.slice(0, 5)).toEqual(['new-session', '-d', '-s', 'codex-claude-session', '-c'])
    expect(invocation.args).toContain('/repo')
    expect(invocation.args.at(-1)).toContain("'claude'")
    expect(invocation.args.at(-1)).toContain("'--permission-mode'")
    expect(invocation.args.at(-1)).not.toContain("plan O'\\''Hara")
  })

  it('builds tmux invocations that paste and submit the prompt after TUI startup', () => {
    expect(
      buildTmuxPromptSubmissionInvocations({
        bufferName: 'codex-claude-session-prompt',
        prompt: "plan O'Hara\nwith newline",
        sessionName: 'codex-claude-session',
      }),
    ).toEqual([
      {
        command: 'tmux',
        args: ['set-buffer', '-b', 'codex-claude-session-prompt', "plan O'Hara\nwith newline"],
      },
      {
        command: 'tmux',
        args: ['paste-buffer', '-b', 'codex-claude-session-prompt', '-t', 'codex-claude-session'],
      },
      {
        command: 'tmux',
        args: ['delete-buffer', '-b', 'codex-claude-session-prompt'],
      },
      {
        command: 'tmux',
        args: ['send-keys', '-t', 'codex-claude-session', 'Enter'],
      },
    ])
  })

  it('parses CLI mode and timeout', () => {
    expect(parseArgs(['review', '--timeout-ms', '1200'])).toEqual({
      mode: 'review',
      timeoutMs: 1200,
    })
  })

  it('rejects --timeout-ms without a value', () => {
    expect(() => parseArgs(['review', '--timeout-ms'])).toThrow('--timeout-ms requires a value')
  })
})

describe('Claude transcript parsing and failures', () => {
  it('parses the last assistant text block from a Claude project transcript', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'Use the tmux runtime.' },
          ],
        },
      }),
    ].join('\n')

    expect(parseTranscriptAnswer(raw)).toBe('Use the tmux runtime.')
  })

  it('finds a direct Claude project transcript path', async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), 'claude-home-'))
    const cwd = '/repo/path'
    const sessionId = 'session-1'
    const projectDir = join(claudeHome, 'projects', projectDirectoryName(cwd))
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`)

    await mkdir(projectDir, { recursive: true })
    await writeFile(transcriptPath, '{}\n')

    try {
      await expect(findClaudeTranscriptPath({ cwd, sessionId, claudeHome })).resolves.toBe(transcriptPath)
    } finally {
      await rm(claudeHome, { force: true, recursive: true })
    }
  })

  it('finds only deterministic direct transcript paths without fallback scanning', async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), 'claude-home-'))

    try {
      await expect(findDirectClaudeTranscriptPath({
        cwd: '/repo/path',
        sessionId: 'missing-session',
        claudeHome,
      })).resolves.toBeNull()
    } finally {
      await rm(claudeHome, { force: true, recursive: true })
    }
  })

  it('parses transcript answers from the end instead of scanning only forward', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'older' }] } }),
      '{bad json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'newer' }] } }),
    ].join('\n')

    expect(parseTranscriptAnswer(raw)).toBe('newer')
  })

  it('builds a local runtime handoff', () => {
    expect(
      buildHandoff({
        answer: 'Use tmux.',
        cwd: '/repo',
        mode: 'plan',
        sessionId: 'session-1',
      }),
    ).toMatchObject({
      ok: true,
      source: 'claude-tui',
      mode: 'plan',
      sessionId: 'session-1',
      cwd: '/repo',
      answer: 'Use tmux.',
    })
  })

  it('classifies missing tmux failures', () => {
    expect(classifyLaunchFailure(new Error('spawn tmux ENOENT'))).toBe('Claude TUI adviser requires `tmux` on PATH.')
  })

  it('classifies missing Claude CLI failures', () => {
    expect(classifyLaunchFailure(new Error('spawn claude ENOENT'))).toBe('Claude TUI adviser requires `claude` on PATH.')
  })

  it('classifies timeout failures', () => {
    expect(classifyLaunchFailure(new Error('Claude TUI adviser timed out waiting for Stop.'))).toBe(
      'Claude TUI adviser timed out before producing a handoff.',
    )
  })
})
