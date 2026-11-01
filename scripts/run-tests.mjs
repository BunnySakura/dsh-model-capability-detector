/**
 * Cross-platform test entry. `node --test` handles globs and directories
 * differently across Node 20, 22 and 24, and Windows shells do not expand
 * wildcards, so the test files are listed explicitly here.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const files = readdirSync(new URL('test/', root))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `test/${name}`)

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: fileURLToPath(root),
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
