// fallow-ignore-file unused-file
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

const wrappers = [
  ['codex-claude-review', 'review'],
  ['codex-claude-plan', 'plan'],
]
const legacyWrappers = [
  'codex-claude-review-stream',
  'codex-claude-plan-stream',
]

const withTempBinDir = async (callback) => {
  const binDir = await mkdtemp(join(tmpdir(), 'codex-claude-bin-'))
  try {
    await callback(binDir)
  } finally {
    await rm(binDir, { force: true, recursive: true })
  }
}

const expectMissing = async (binDir, command) => {
  await expect(stat(join(binDir, command))).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('Claude wrapper installer', () => {
  it('installs executable wrappers and uninstalls them', async () => {
    await withTempBinDir(async (binDir) => {
      await runInstaller(binDir)

      for (const [command, mode] of wrappers) {
        const wrapperPath = join(binDir, command)
        const stats = await stat(wrapperPath)
        const source = await readFile(wrapperPath, 'utf8')

        expect(stats.mode & 0o111).not.toBe(0)
        expect(source).toContain(`const MODE = "${mode}"`)
        expect(source).not.toContain('CODEX_CLAUDE_STREAM_PANE')
      }

      await runInstaller(binDir, ['--uninstall'])

      for (const [command] of wrappers) {
        await expectMissing(binDir, command)
      }
    })
  })

  it('removes legacy stream wrappers during install', async () => {
    await withTempBinDir(async (binDir) => {
      for (const command of legacyWrappers) {
        await writeFile(join(binDir, command), 'legacy wrapper\n', 'utf8')
      }

      await runInstaller(binDir)

      for (const command of legacyWrappers) {
        await expectMissing(binDir, command)
      }
    })
  })
})
