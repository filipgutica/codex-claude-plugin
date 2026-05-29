---
name: setup
description: User-invoked only. Use when the user explicitly asks to set up, install, refresh, or uninstall stable local wrapper commands for Claude plugin plan/review runs.
---

# Claude Setup

Install or remove stable local wrapper commands for the Claude plugin. These
wrappers let Codex trust narrow command names instead of versioned plugin cache
paths.

## Workflow

1. Resolve this installed plugin root from the current skill file path. The
   installer lives at:

```text
<plugin-root>/scripts/install-wrappers.mjs
```

2. To install or refresh wrapper commands, run:

```bash
node <plugin-root>/scripts/install-wrappers.mjs
```

3. To uninstall wrapper commands, run:

```bash
node <plugin-root>/scripts/install-wrappers.mjs --uninstall
```

The installer writes to `~/.local/bin` by default. Set `CODEX_CLAUDE_BIN_DIR`
when the user asks for a different directory.

4. After install, tell the user to add these trusted command rules to
   `~/.codex/rules/default.rules` if they want no-confirm plan/review runs:

```text
prefix_rule(pattern=["codex-claude-review"], decision="allow")
prefix_rule(pattern=["codex-claude-plan"], decision="allow")
prefix_rule(pattern=["codex-claude-review-stream"], decision="allow")
prefix_rule(pattern=["codex-claude-plan-stream"], decision="allow")
```

   The review and plan skills call these wrappers directly with `--prompt` or
   `--prompt-file`, so Codex can match the wrapper command prefix without
   trusting a shell pipeline. The wrappers stream bounded Claude tmux pane
   snapshots by default for visibility during long-running plan/review runs; set
   `CODEX_CLAUDE_STREAM_PANE=0` only when the user explicitly wants a quiet run.
   If Claude asks a blocking clarification question, Codex can resume the same
   tmux session through the same wrapper with `--resume <statePath> --answer
   <text>`.
   `CODEX_CLAUDE_IDLE_TIMEOUT_MS` tunes the no-activity timeout, and
   `CODEX_CLAUDE_HARD_TIMEOUT_MS` adds an absolute cap only when one is needed.

5. Remind the user to restart Codex after editing `default.rules`.

## Failure Handling

If the installer fails because `node` is unavailable, report that Node.js 20.16
or newer is required. If wrapper commands are installed but not found later,
check whether the install directory is on `PATH`.
