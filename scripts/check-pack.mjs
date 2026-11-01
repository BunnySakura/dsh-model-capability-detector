/**
 * Checks the file list `npm pack --dry-run --json` reports, so a release can
 * never ship tests, scripts, caches, logs or environment files.
 *
 * Run: npm pack --dry-run --json | node scripts/check-pack.mjs
 */
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)

let files
try {
  files = JSON.parse(Buffer.concat(chunks).toString('utf8'))[0].files.map((file) => file.path)
} catch {
  console.error('check-pack: expected the JSON output of `npm pack --dry-run --json` on stdin')
  process.exit(2)
}

const REQUIRED = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'data/verified.json', 'README.md', 'LICENSE']
const FORBIDDEN = [
  [/^test\//, 'tests'],
  [/^scripts\//, 'maintainer scripts'],
  [/^\.github\//, 'CI configuration'],
  [/(^|\/)\.env/, 'environment file'],
  [/\.(?:log|jsonl|tgz)$/, 'log or archive'],
  [/(^|\/)(?:cache|logs|node_modules)\//, 'local state'],
]

const problems = [
  ...REQUIRED.filter((name) => !files.includes(name)).map((name) => `missing ${name}`),
  ...files.flatMap((name) => FORBIDDEN.filter(([pattern]) => pattern.test(name)).map(([, why]) => `${name} (${why})`)),
]
if (problems.length > 0) {
  console.error('check-pack: the package contents are wrong')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`check-pack: ${files.length} files, contents as expected`)
