import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

const runtimePath = 'plugins/claude-plugin/scripts/claude-tui-adviser.mjs'
const generatedHeader = [
  '// fallow-ignore-file unused-file',
  '// fallow-ignore-file unused-export',
  '// fallow-ignore-file code-duplication',
]
const checkOnly = process.argv.includes('--check')

const run = async (command, args) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, { stdio: 'inherit' })
  child.once('error', rejectPromise)
  child.once('exit', (code) => {
    if (code === 0) {
      resolvePromise()
      return
    }

    rejectPromise(new Error(`${command} exited with ${code}`))
  })
})

const stampGeneratedHeader = async () => {
  const raw = await readFile(runtimePath, 'utf8')
  const withoutExistingHeader = stripLeadingFallowHeader(raw.split('\n'))

  await writeFile(runtimePath, `${generatedHeader.join('\n')}\n${withoutExistingHeader.join('\n')}`)
}

const stripLeadingFallowHeader = (lines) => {
  const firstNonHeader = lines.findIndex((line) => !line.startsWith('// fallow-ignore-file '))
  return firstNonHeader === -1 ? [] : lines.slice(firstNonHeader)
}

const before = checkOnly ? await readFile(runtimePath, 'utf8') : null
await run('tsc', ['-p', 'tsconfig.json'])
await stampGeneratedHeader()

if (before !== null) {
  const after = await readFile(runtimePath, 'utf8')
  if (before !== after) {
    throw new Error(`${runtimePath} is stale. Run pnpm build:runtime and commit the generated output.`)
  }
}
