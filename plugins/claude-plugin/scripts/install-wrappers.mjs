#!/usr/bin/env node
// fallow-ignore-file unused-file
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const DEFAULT_BIN_DIR = join(homedir(), '.local', 'bin')
const BIN_DIR = resolve(process.env.CODEX_CLAUDE_BIN_DIR || DEFAULT_BIN_DIR)
const WRAPPERS = [
  { command: 'codex-claude-review', mode: 'review' },
  { command: 'codex-claude-plan', mode: 'plan' },
]
const LEGACY_WRAPPERS = [
  'codex-claude-review-stream',
  'codex-claude-plan-stream',
]

const usage = [
  'Usage: node install-wrappers.mjs [--uninstall]',
  '',
  `Installs Claude plugin wrapper commands into ${DEFAULT_BIN_DIR}.`,
  'Set CODEX_CLAUDE_BIN_DIR to choose a different install directory.',
].join('\n')

const parseArgs = (argv) => {
  if (argv.length === 0) return { uninstall: false }
  if (argv.length > 1) throw new Error(usage)
  return parseOption(argv[0])
}

const parseOption = (option) => {
  if (option === '--uninstall') return { uninstall: true }
  if (option === '--help' || option === '-h') {
    console.log(usage)
    process.exit(0)
  }
  throw new Error(usage)
}

const wrapperSource = ({ mode }) => `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { accessSync, readdirSync } from 'node:fs'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODE = ${JSON.stringify(mode)}

const compareVersions = (left, right) => left.localeCompare(right, undefined, {
  numeric: true,
  sensitivity: 'base',
})

const helperExists = (path) => {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

const latestHelperPath = () => {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  const pluginVersionsDir = join(codexHome, 'plugins', 'cache', 'codex-claude-plugin', 'claude-plugin')
  let versions = []
  try {
    versions = readdirSync(pluginVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersions)
  } catch {
    throw new Error(\`Could not find installed claude-plugin cache at \${pluginVersionsDir}.\`)
  }

  const helperPath = versions
    .map((version) => join(pluginVersionsDir, version, 'scripts', 'claude-tui-adviser.mjs'))
    .filter(helperExists)
    .at(-1)

  if (helperPath === undefined) {
    throw new Error(\`Could not find claude-tui-adviser.mjs under \${pluginVersionsDir}.\`)
  }

  return helperPath
}

let helperPath
try {
  helperPath = latestHelperPath()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const child = spawn(process.execPath, [helperPath, MODE, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
})

child.once('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
`

const isOnPath = (dir) => process.env.PATH
  ?.split(delimiter)
  .map((entry) => resolve(entry || '.'))
  .includes(dir) || false

const installWrappers = async () => {
  await mkdir(BIN_DIR, { recursive: true })
  for (const wrapper of WRAPPERS) {
    const targetPath = join(BIN_DIR, wrapper.command)
    await writeFile(targetPath, wrapperSource(wrapper), 'utf8')
    await chmod(targetPath, 0o755)
    console.log(`Installed ${targetPath}`)
  }
  await removeLegacyWrappers()

  if (!isOnPath(BIN_DIR)) {
    console.error(`Warning: ${BIN_DIR} is not on PATH. Add it before using the wrapper commands.`)
  }
}

const uninstallWrappers = async () => {
  for (const { command } of WRAPPERS) {
    const targetPath = join(BIN_DIR, command)
    await rm(targetPath, { force: true })
    console.log(`Removed ${targetPath}`)
  }
  await removeLegacyWrappers()
}

const removeLegacyWrappers = async () => {
  for (const command of LEGACY_WRAPPERS) {
    const targetPath = join(BIN_DIR, command)
    await rm(targetPath, { force: true })
    console.log(`Removed legacy ${targetPath}`)
  }
}

try {
  const { uninstall } = parseArgs(process.argv.slice(2))
  if (uninstall) {
    await uninstallWrappers()
  } else {
    await installWrappers()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
