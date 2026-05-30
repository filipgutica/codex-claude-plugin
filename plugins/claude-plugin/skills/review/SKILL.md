---
name: review
description: User-invoked only. Use when the user explicitly asks Codex to ask Claude CLI for a review of the current code changes, branch diff, or pending implementation.
---

# Claude Review

Use Claude CLI as an external reviewer for current changes. Codex remains
responsible for triage, verification, and deciding whether findings are real.

Treat this as an interactive background review, not a fire-and-forget command.
Report concise progress to the user while Claude is running, using streamed
tmux pane snapshots and the eventual JSON handoff as evidence. Do not stop a
live Claude session just because it appears slow or stuck in a long progress
state; ask the user before stopping a live session for time or cost reasons.

## Workflow

1. Determine the review scope: uncommitted changes by default, or the branch
   diff/base ref if the user specifies one.
2. Prefer the installed wrapper command. Pass the request directly with
   `--prompt`, or use `--prompt-file` for larger review prompts. The wrapper
   drives the interactive Claude TUI through a local `tmux` session before
   returning JSON output:

```bash
codex-claude-review --prompt "<prompt>"
```

   The wrapper resolves the latest installed plugin helper from Codex's plugin
   cache. If `codex-claude-review` is not available, ask the user to run
   `$claude-plugin:setup`, or use the direct helper script from this plugin root
   as a development fallback:

```bash
node <plugin-root>/scripts/claude-tui-adviser.mjs review --prompt "<prompt>"
```

   The helper owns the fragile TUI lifecycle: starting a `tmux` session,
   waiting for Claude `SessionStart` readiness, waiting for the `Stop` hook, and
   extracting the final answer from Claude's persisted transcript. It streams
   bounded tmux pane snapshots to stderr by default so Codex and the user can
   see what Claude is doing while stdout remains the handoff JSON. If
   Claude asks a blocking clarification question, the helper returns a
   `status: "needs_input"` handoff with `question`, `statePath`,
   `attachCommand`, and `resumeCommand`, and leaves the tmux session alive.
   Run this command outside Codex's default sandbox. It invokes `tmux` and the
   local Claude TUI, which may need PTY support, Claude auth, keychain/session
   files, and home-directory access that the sandbox can block. In Codex, use
   the shell tool's escalation or approval path for this helper command instead
   of retrying inside the default workspace sandbox.
3. Ask Claude to review for correctness, regressions, missed tests, public API
   or behavior changes, and risky edge cases. Tell it not to edit files.
4. If the handoff has `status: "needs_input"`, decide whether Codex can answer
   from the current diff, repo context, or the user's request. If yes, continue
   the same Claude session:

```bash
codex-claude-review --resume "<statePath>" --answer "<Codex answer>"
```

   If answering would require user intent or product judgment, stop and forward
   Claude's question to the user. After the user answers, resume the same
   Claude session with `--answer` or `--answer-file`. Mention that the user can
   inspect the live interaction with the returned `attachCommand`.
5. Check each finding against the actual repo before presenting or acting on it.
6. Present Claude's review only after triage:
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

If you are blocked by missing requirements, ask exactly one clarification
question starting with `QUESTION_FOR_CODEX:` and wait for Codex to answer.
```

## Failure Handling

If `tmux` or `claude` is unavailable, Claude is not authenticated, the TUI exits
or disappears before producing a handoff, a configured hard timeout is reached,
or the helper fails even outside the sandbox, report the failure and continue
with Codex's own review instead of blocking.
