import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = join(repoRoot, 'plugins')

let errors = 0

const fail = (message) => {
  console.error(`  FAIL: ${message}`)
  errors++
}

const validateJson = async (path, requiredFields = []) => {
  try {
    const content = await readFile(path, 'utf8')
    const parsed = JSON.parse(content)
    for (const field of requiredFields) {
      if (!(field in parsed)) fail(`${path} is missing required field: "${field}"`)
    }
    return parsed
  } catch (err) {
    fail(`${path} — ${err.message}`)
    return null
  }
}

const validateSkillMd = async (path) => {
  const content = await readFile(path, 'utf8').catch((err) => {
    fail(`${path} — ${err.message}`)
    return null
  })
  if (content === null) return
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) {
    fail(`${path} — missing YAML frontmatter`)
    return
  }
  if (!match[1].includes('description:')) {
    fail(`${path} — frontmatter missing required field: "description"`)
  }
}

const pathExists = async (path) => {
  try {
    await stat(path)
    return true
  } catch (err) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

const readDirectoryNames = async (path) => (
  await readdir(path, { withFileTypes: true }).catch((err) => {
    fail(`${path} — ${err.message}`)
    return []
  })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

console.log('Validating plugin manifests...')

await validateJson(join(repoRoot, '.agents/plugins/marketplace.json'), ['name', 'plugins'])

const pluginDirs = await readDirectoryNames(pluginsRoot)

for (const pluginDir of pluginDirs) {
  const pluginRoot = join(pluginsRoot, pluginDir)

  const codexManifest = join(pluginRoot, '.codex-plugin/plugin.json')
  const hasCodexManifest = await pathExists(codexManifest)

  if (!hasCodexManifest) {
    fail(`${pluginRoot} is missing a Codex plugin manifest`)
  }

  if (hasCodexManifest) {
    await validateJson(codexManifest, ['name', 'skills'])
  }

  const hooksDir = join(pluginRoot, 'hooks')
  const hooksFiles = await readdir(hooksDir).catch(() => [])
  for (const hooksFile of hooksFiles.filter((file) => file.endsWith('.json')).sort()) {
    await validateJson(join(hooksDir, hooksFile), ['hooks'])
  }

  const skillsDir = join(pluginRoot, 'skills')
  const skills = await readdir(skillsDir).catch(() => [])
  for (const skill of skills) {
    await validateSkillMd(join(skillsDir, skill, 'SKILL.md'))
  }
}

if (errors > 0) {
  console.error(`\n${errors} validation error(s) found.`)
  process.exit(1)
}

console.log('All checks passed.')
