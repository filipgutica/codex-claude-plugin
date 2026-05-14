---
name: plan
description: User-invoked only. Use when the user explicitly asks Codex to ask Claude CLI for a richer implementation plan, second opinion on approach, or planning pass before implementation.
---

# Claude Plan

Use Claude CLI as an external planning adviser. Claude's plan is input for
Codex to enrich and inform its own plan; Codex remains responsible for the
final plan, scope control, and deciding what to implement.

## Workflow

1. Summarize the user's goal, relevant constraints, and current repo context.
2. Run the Claude TUI adviser helper from the repository root. The helper reads
   the prompt from stdin and drives the interactive Claude TUI through a local
   `tmux` session before returning JSON output:

```bash
printf '%s' "<prompt>" | node plugins/claude-plugin/scripts/claude-tui-adviser.mjs plan
```

   The helper owns the fragile TUI lifecycle: starting a `tmux` session,
   waiting for Claude `SessionStart` readiness, waiting for the `Stop` hook, and
   extracting the final answer from Claude's persisted transcript. Run this
   command outside Codex's default sandbox. It invokes `tmux` and the local
   Claude TUI, which may need PTY support, Claude auth, keychain/session files,
   and home-directory access that the sandbox can block. In Codex, use the
   shell tool's escalation or approval path for this helper command instead of
   retrying inside the default workspace sandbox.
3. Ask Claude for a concise implementation plan grounded in the current repo.
   Include any known constraints, files, test expectations, and open questions.
4. Read the returned handoff JSON critically. Do not treat it as authoritative.
5. Use the useful parts to enrich Codex's own plan, corrected for repo reality
   and Codex judgment. Call out any parts you rejected or could not verify.

## Prompt Shape

Use a prompt like:

```text
You are advising Codex on an implementation plan.

Goal:
<user goal>

Known context:
<repo, files, constraints, current findings>

Please inspect the repository as needed and produce a practical implementation
plan. Focus on sequencing, risks, validation, and minimal changes. Do not edit
files.
```

## Failure Handling

If `tmux` or `claude` is unavailable, Claude is not authenticated, the TUI times
out, or the helper fails even outside the sandbox, report the failure and
continue with Codex's own planning instead of blocking.
