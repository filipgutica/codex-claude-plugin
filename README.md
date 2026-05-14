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

- `plan` - invokes the local Claude TUI runtime for an ephemeral read-only
  Claude session and folds the JSON handoff into Codex's own plan after
  validation.
- `review` - uses the same local TUI runtime for advisory code review, then has
  Codex validate and separate confirmed, rejected, and actionable findings.

The Claude adviser helper intentionally avoids `claude -p` and external PTY
wrappers. It runs the authenticated local Claude CLI in interactive mode inside
a required local `tmux` session, waits for Claude lifecycle hooks, reads the
final assistant answer from Claude's persisted transcript, and normalizes that
result into a Codex handoff. If Codex sandboxing blocks `tmux`, Claude auth,
keychain access, session files, or TUI startup, run the helper outside the
default sandbox and let Codex continue with its own plan or review if the
handoff fails.

Runtime requirements:

- Claude Code CLI available as `claude` on `PATH` and already authenticated
- `tmux` available on `PATH`
- Node.js 20.16 or newer

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
