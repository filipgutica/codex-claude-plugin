// fallow-ignore-file unused-file
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const installerPath = join(process.cwd(), 'plugins/claude-plugin/scripts/install-wrappers.mjs')

const runInstaller = (binDir, args = []) => execFileAsync(process.execPath, [installerPath, ...args], {
  env: {
    ...process.env,
    CODEX_CLAUDE_BIN_DIR: binDir,
  },
})

describe('Claude wrapper installer', () => {
  it('installs executable wrappers and uninstalls them', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'codex-claude-bin-'))
    const wrappers = [
      ['codex-claude-review', 'review', false],
      ['codex-claude-plan', 'plan', false],
      ['codex-claude-review-stream', 'review', true],
      ['codex-claude-plan-stream', 'plan', true],
    ]

    try {
      await runInstaller(binDir)

      for (const [command, mode, stream] of wrappers) {
        const wrapperPath = join(binDir, command)
        const stats = await stat(wrapperPath)
        const source = await readFile(wrapperPath, 'utf8')

        expect(stats.mode & 0o111).not.toBe(0)
        expect(source).toContain(`const MODE = "${mode}"`)
        expect(source).toContain(`const STREAM = ${stream}`)
      }

      await runInstaller(binDir, ['--uninstall'])

      for (const [command] of wrappers) {
        await expect(stat(join(binDir, command))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await rm(binDir, { force: true, recursive: true })
    }
  })
})
