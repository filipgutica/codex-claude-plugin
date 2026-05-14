---
name: review
description: User-invoked only. Use when the user explicitly asks Codex to ask Claude CLI for a review of the current code changes, branch diff, or pending implementation.
---

# Claude Review

Use Claude CLI as an external reviewer for current changes. Codex remains
responsible for triage, verification, and deciding whether findings are real.

## Workflow

1. Determine the review scope: uncommitted changes by default, or the branch
   diff/base ref if the user specifies one.
2. Run the Claude TUI adviser helper from the repository root. The helper reads
   the prompt from stdin and drives the interactive Claude TUI through a local
   `tmux` session before returning JSON output:

```bash
printf '%s' "<prompt>" | node plugins/claude-plugin/scripts/claude-tui-adviser.mjs review
```

   The helper owns the fragile TUI lifecycle: starting a `tmux` session,
   waiting for Claude `SessionStart` readiness, waiting for the `Stop` hook, and
   extracting the final answer from Claude's persisted transcript. Run this
   command outside Codex's default sandbox. It invokes `tmux` and the local
   Claude TUI, which may need PTY support, Claude auth, keychain/session files,
   and home-directory access that the sandbox can block. In Codex, use the
   shell tool's escalation or approval path for this helper command instead of
   retrying inside the default workspace sandbox.
3. Ask Claude to review for correctness, regressions, missed tests, public API
   or behavior changes, and risky edge cases. Tell it not to edit files.
4. Check each finding against the actual repo before presenting or acting on it.
5. Present Claude's review only after triage:
   - Claude's review summary
   - confirmed actionable findings
   - uncertain or rejected findings
   - Codex's action plan for valid findings

## Prompt Shape

Use a prompt like:

```text
You are reviewing Codex's current changes.

Scope:
<uncommitted changes, branch diff, PR, or user-specified files>

Please inspect the repository and current diff as needed. Return only actionable
findings ordered by severity. Focus on bugs, regressions, missed tests, and
contract drift. Mark uncertain findings separately. Do not edit files.
```

## Failure Handling

If `tmux` or `claude` is unavailable, Claude is not authenticated, the TUI times
out, or the helper fails even outside the sandbox, report the failure and
continue with Codex's own review instead of blocking.
