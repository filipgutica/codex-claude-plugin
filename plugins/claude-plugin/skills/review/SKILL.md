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
   the prompt from stdin and invokes `npx -y claude-p`, which drives the
   interactive Claude TUI through a real PTY and returns JSON output:

```bash
printf '%s' "<prompt>" | node plugins/claude-plugin/scripts/claude-tui-adviser.mjs review
```

   `claude-p` owns the fragile TUI lifecycle: terminal probing, `SessionStart`
   readiness, prompt entry, `Stop` hook completion, and transcript extraction.
   The helper keeps the plugin contract small by using `npx -y claude-p` as the
   single execution path and normalizing its JSON result into a Codex handoff.
   Run this command outside Codex's default sandbox when sandboxing blocks
   Claude auth, keychain, or TUI startup.
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
contract drift. Do not edit files.
```

## Failure Handling

If `npx`, the `claude-p` package, or `claude` is unavailable, Claude is not
authenticated, the TUI times out, or the helper fails, report the failure and
continue with Codex's own review instead of blocking.
