# Codex Claude Plugin

Codex-only plugin marketplace for asking the local Claude CLI for advisory
planning and review passes.

## Distribution Model

This repo is a git-based Codex marketplace. No build step is required for the
plugin payload: the Codex plugin files are tracked directly in git and
versioned on release.

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
  scripts/                 claude-p launcher and JSON handoff runtime
.agents/plugins/           Codex git marketplace registry (marketplace.json)
scripts/                   Stamp and validate scripts
tests/                     claude-p handoff tests
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

- `plan` - invokes `claude-p` for an ephemeral read-only Claude TUI session and
  folds the JSON handoff into Codex's own plan after validation.
- `review` - uses the same `claude-p` path for advisory code review, then has
  Codex validate and separate confirmed, rejected, and actionable findings.

The Claude adviser helper intentionally avoids `claude -p` by running
[`npx -y claude-p`](https://github.com/smithersai/claude-p) as its single
execution path. `claude-p` runs the local Claude CLI in interactive mode with a
real PTY, handles terminal startup probes, waits for `SessionStart`, sends the
prompt, waits for `Stop`, and emits JSON compatible with
`claude -p --output-format json`. The helper normalizes that result into a
Codex handoff. If Codex sandboxing blocks package resolution, Claude auth,
keychain access, or TUI startup, run the helper outside the default sandbox and
let Codex continue with its own plan or review if the handoff fails.

## CI

- **validate** - runs on all PRs and pushes: plugin manifest validation and
  tests
- **release** - runs on push to `main` after validate: semantic-release bumps
  version, stamps plugin manifests, commits back, creates GitHub release

## Development

```sh
pnpm validate-plugins
pnpm test
pnpm check          # validate plugin manifests + tests
```
