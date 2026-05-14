// fallow-ignore-file unused-file
import { describe, expect, it } from 'vitest'

import {
  buildClaudePArgs,
  buildClaudePInvocation,
  buildClaudePrompt,
  classifyLaunchFailure,
  parseArgs,
  parseClaudePResult,
} from '../plugins/claude-plugin/scripts/claude-tui-adviser.mjs'

describe('claude tui adviser prompt and args', () => {
  it('builds a plan prompt that keeps Claude advisory and read-only', () => {
    const prompt = buildClaudePrompt({
      mode: 'plan',
      input: 'Add the claude-p handoff flow.',
      cwd: '/repo',
    })

    expect(prompt).toContain('advising Codex on a plan')
    expect(prompt).toContain('Codex remains responsible')
    expect(prompt).toContain('Do not edit files')
    expect(prompt).toContain('Add the claude-p handoff flow.')
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

  it('builds claude-p args for JSON output and a read-only tool set', () => {
    expect(
      buildClaudePArgs({
        prompt: 'prompt',
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        timeoutMs: 1200,
      }),
    ).toEqual([
      '--output-format',
      'json',
      '--timeout',
      '2',
      '--tools',
      'Read,Glob,Grep,LS',
      '--session-id',
      '123e4567-e89b-12d3-a456-426614174000',
      'prompt',
    ])
  })

  it('builds the hard npx claude-p invocation', () => {
    const invocation = buildClaudePInvocation({
      prompt: 'prompt',
      sessionId: 'session-1',
      timeoutMs: 1000,
    })

    expect(invocation.command).toBe('npx')
    expect(invocation.args.slice(0, 2)).toEqual(['-y', 'claude-p'])
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

describe('claude-p result parsing and failures', () => {
  it('parses a successful claude-p JSON result', () => {
    expect(
      parseClaudePResult({
        raw: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-from-claude-p',
          result: 'Use claude-p.',
        }),
        mode: 'plan',
        sessionId: 'fallback-session',
        cwd: '/repo',
      }),
    ).toMatchObject({
      ok: true,
      source: 'claude-p',
      mode: 'plan',
      sessionId: 'session-from-claude-p',
      cwd: '/repo',
      answer: 'Use claude-p.',
    })
  })

  it('rejects claude-p error results', () => {
    expect(() =>
      parseClaudePResult({
        raw: JSON.stringify({ is_error: true, result: 'permission denied' }),
        mode: 'review',
        sessionId: 'session-1',
      }),
    ).toThrow('permission denied')
  })

  it('rejects claude-p JSON without an answer', () => {
    expect(() =>
      parseClaudePResult({
        raw: JSON.stringify({ is_error: false }),
        mode: 'review',
        sessionId: 'session-1',
      }),
    ).toThrow('claude-p did not include an answer')
  })

  it('rejects noncanonical answer fields', () => {
    expect(() =>
      parseClaudePResult({
        raw: JSON.stringify({ is_error: false, final_text: 'legacy alias' }),
        mode: 'review',
        sessionId: 'session-1',
      }),
    ).toThrow('claude-p did not include an answer')
  })

  it('classifies missing claude-p failures', () => {
    expect(classifyLaunchFailure(new Error('spawn npx ENOENT'))).toBe(
      'Claude TUI adviser requires `npx` to run `claude-p`.',
    )
  })

  it('classifies timeout failures', () => {
    expect(classifyLaunchFailure(new Error('npx claude-p exited with 124'))).toBe(
      'Claude TUI adviser timed out before producing a handoff.',
    )
  })
})
