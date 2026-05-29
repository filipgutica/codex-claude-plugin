# Codex Claude Plugin

Codex-only plugin marketplace for asking the local Claude CLI for advisory
planning and review passes.

## Distribution Model

This repo is a git-based Codex marketplace. Consumers do not run a build step
after installing the plugin: the Codex plugin payload is tracked directly in git
and versioned on release. Development changes to the TypeScript runtime must be
compiled before commit so the tracked plugin script stays current.

The marketplace ships one plugin:

- `claude-plugin` - user-invoked Claude TUI planning and review adviser for
  Codex

Claude output is advisory only. Codex must validate the handoff against repo
reality before acting on it, and Codex remains responsible for scope,
correctness, and implementation decisions.

The intended workflow is interactive. Codex runs Claude in the background
through the local TUI and tmux, reports progress from the streamed pane output,
and folds Claude's final handoff into Codex's own plan or review. If Claude asks
a blocking clarification question, Codex can answer from verified context or
forward the question to the user, then resume the same Claude session.

## Repo Layout

```text
plugins/claude-plugin/     Codex-only Claude CLI adviser plugin
  .codex-plugin/           Codex plugin manifest
  skills/                  plan and review skills
  src/                     TypeScript source for the local TUI runtime
  scripts/                 compiled local TUI runtime and JSON handoff helper
.agents/plugins/           Codex git marketplace registry (marketplace.json)
scripts/                   Stamp and validate scripts
tests/                     Claude TUI handoff tests
```

## Codex Install

```sh
codex plugin marketplace add filipgutica/codex-claude-plugin
```

Then restart Codex, open Codex's plugin UI, and install `claude-plugin` from
the `codex-claude-plugin` marketplace.

Codex reads `.agents/plugins/marketplace.json` at the repo root, which lists
`claude-plugin` and points its source path at `./plugins/claude-plugin`.

Codex's CLI only manages marketplace registration and refreshes; plugin
installation happens from Codex's plugin UI. Marketplace commands target the
marketplace name directly, so the upgrade command uses `codex-claude-plugin`
rather than a `plugin@marketplace` identifier.

When a new version is released, refresh the marketplace with:

```sh
codex plugin marketplace upgrade codex-claude-plugin
```

The Codex marketplace version is stamped from `package.json` during the release
workflow into:

```text
.agents/plugins/marketplace.json
plugins/*/.codex-plugin/plugin.json
```

## Versioning

Versioning is automated via semantic-release on every push to `main`. Commit
messages follow [Conventional Commits](https://www.conventionalcommits.org/):

| Commit prefix | Version bump |
|---|---|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or `BREAKING CHANGE:` | major |

Commit messages are validated locally by commitlint via the lefthook
`commit-msg` hook. On merge to `main`, CI bumps `package.json`, stamps the
version into `plugins/*/.codex-plugin/plugin.json` and
`.agents/plugins/marketplace.json`, and creates a GitHub release. No manual
version commands needed.

## Included Skills

The `claude-plugin` Codex plugin includes:

- `setup` - installs or uninstalls stable local wrapper commands for no-confirm
  Claude plan/review runs.
- `plan` - invokes the local Claude TUI runtime in Claude Plan Mode for an
  ephemeral read-only Claude session and folds the JSON handoff into Codex's own
  plan after validation.
- `review` - uses the same local TUI runtime for advisory code review, then has
  Codex validate and separate confirmed, rejected, and actionable findings. The
  review runtime pins Claude Code to `--model sonnet` and read-only tools
  instead of Claude Plan Mode.

The Claude adviser helper intentionally avoids `claude -p` and external PTY
wrappers. It runs the authenticated local Claude CLI in interactive mode inside
a required local `tmux` session, waits for Claude lifecycle hooks, reads the
final assistant answer from Claude's persisted transcript, and normalizes that
result into a Codex handoff. When Claude asks a clarification question with the
structured `QUESTION_FOR_CODEX:` prefix, the helper returns a `needs_input`
handoff with the question, a tmux attach command for inspection, and resume
state for continuing the same Claude session. If Codex sandboxing blocks
`tmux`, Claude auth, keychain access, session files, or TUI startup, run the
helper outside the default sandbox and let Codex continue with its own plan or
review if the handoff fails.

Runtime requirements:

- Claude Code CLI available as `claude` on `PATH` and already authenticated
- `tmux` available on `PATH`
- Node.js 20.16 or newer

## Trusted Commands

Install-only users can run `$claude-plugin:setup` once to install stable wrapper
commands into `~/.local/bin`:

```text
codex-claude-review
codex-claude-plan
```

The setup command uses the installed plugin cache and does not require cloning
this repository. The wrappers resolve the latest installed plugin helper at
runtime. Skills invoke these wrappers directly with `--prompt` or
`--prompt-file`, so the trusted command is the wrapper itself rather than a
shell pipeline. The helper streams bounded Claude tmux pane snapshots to stderr
by default for visibility during long-running reviews and plans; stdout remains
the handoff JSON. Set `CODEX_CLAUDE_STREAM_PANE=0` to disable pane
streaming. If the JSON handoff has `status: "needs_input"`, answer Claude and
continue the same session with:

```sh
codex-claude-plan --resume "<statePath>" --answer "<answer>"
codex-claude-review --resume "<statePath>" --answer "<answer>"
```

The handoff also includes `attachCommand`, which opens the live tmux session for
inspection while Claude is waiting. `--timeout-ms` is a health-check interval:
when it elapses, the
helper checks tmux, Claude pane state, and transcript activity before deciding
whether to continue. Active Claude runs continue by default. Set
`--idle-timeout-ms` or `CODEX_CLAUDE_IDLE_TIMEOUT_MS` to tune how long a run may
go without detectable activity, and set `--hard-timeout-ms` or
`CODEX_CLAUDE_HARD_TIMEOUT_MS` only when an absolute cap is required.

To remove the wrapper commands later, run `$claude-plugin:setup` with the
uninstall workflow, or run the installed setup script with `--uninstall`.

Add these rules to `~/.codex/rules/default.rules` to let Codex run the wrappers
without repeatedly asking for confirmation:

```text
prefix_rule(pattern=["codex-claude-review"], decision="allow")
prefix_rule(pattern=["codex-claude-plan"], decision="allow")
```

Restart Codex after editing `default.rules` so the new trusted commands are
loaded. `~/.local/bin` must also be on `PATH`.

## CI

- **validate** - runs on all PRs and pushes: plugin manifest validation and
  tests
- **release** - runs on push to `main` after validate: semantic-release bumps
  version, stamps plugin manifests, commits back, creates GitHub release

## Development

```sh
pnpm build:runtime
pnpm validate-plugins
pnpm test
pnpm check          # build runtime, validate plugin manifests, and run tests
```
