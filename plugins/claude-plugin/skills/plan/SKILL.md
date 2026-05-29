---
name: plan
description: User-invoked only. Use when the user explicitly asks Codex to ask Claude CLI for a richer implementation plan, second opinion on approach, or planning pass before implementation.
---

# Claude Plan

Use Claude CLI as an external planning adviser. Claude's plan is input for
Codex to enrich and inform its own plan; Codex remains responsible for the
final plan, scope control, and deciding what to implement.

Treat this as an interactive background collaboration, not a fire-and-forget
command. Report concise progress to the user while Claude is running, using the
streamed tmux pane snapshots and eventual JSON handoff as evidence.

## Workflow

1. Summarize the user's goal, relevant constraints, and current repo context.
2. Prefer the installed wrapper command. Pass the request directly with
   `--prompt`, or use `--prompt-file` for larger planning prompts. The wrapper
   drives the interactive Claude TUI through a local `tmux` session before
   returning JSON output:

```bash
codex-claude-plan --prompt "<prompt>"
```

   The wrapper resolves the latest installed plugin helper from Codex's plugin
   cache. If `codex-claude-plan` is not available, ask the user to run
   `$claude-plugin:setup`, or use the direct helper script from this plugin root
   as a development fallback:

```bash
node <plugin-root>/scripts/claude-tui-adviser.mjs plan --prompt "<prompt>"
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
3. Ask Claude for a concise implementation plan grounded in the current repo.
   Include any known constraints, files, test expectations, and open questions.
4. If the handoff has `status: "needs_input"`, decide whether Codex can answer
   from the user's request or verified repo context. If yes, continue the same
   Claude session:

```bash
codex-claude-plan --resume "<statePath>" --answer "<Codex answer>"
```

   If answering would require user intent or product judgment, stop and forward
   Claude's question to the user. After the user answers, resume the same
   Claude session with `--answer` or `--answer-file`. Mention that the user can
   inspect the live interaction with the returned `attachCommand`.
5. Read the returned complete handoff JSON critically. Do not treat it as
   authoritative.
6. Use the useful parts to enrich Codex's own plan, corrected for repo reality
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

If you are blocked by missing requirements, ask exactly one clarification
question starting with `QUESTION_FOR_CODEX:` and wait for Codex to answer.
```

## Failure Handling

If `tmux` or `claude` is unavailable, Claude is not authenticated, the TUI is
idle past its configured idle timeout, or the helper fails even outside the
sandbox, report the failure and continue with Codex's own planning instead of
blocking.
