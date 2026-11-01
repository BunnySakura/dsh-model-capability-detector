/**
 * Pre-publish scan for material that must not reach a public repository:
 * credentials, local absolute paths with a user name, private keys and personal
 * e-mail addresses. It reads the package directory only, prints file and line
 * but never the matched text, and exits non-zero on any finding.
 *
 * Run: node scripts/privacy-scan.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', '.git', 'cache', 'logs'])
const SKIP_FILES = new Set(['scripts/privacy-scan.mjs'])
const TEXT = /\.(?:js|mjs|cjs|json|ya?ml|toml|md|svg|txt|gitignore|gitattributes|gitleaks\.toml)$|^(?:LICENSE|\.gitignore|\.gitattributes)$/i
const MAX_BYTES = 2 * 1024 * 1024

/** Reserved or placeholder hosts that are safe to publish. */
const SAFE_MAIL_HOST = /@(?:example\.(?:com|org|net|test)|[a-z0-9.-]*\.test|[a-z0-9.-]*\.invalid|users\.noreply\.github\.com)$/i

const RULES = [
  ['windows user path', /\b[A-Za-z]:[\\/]+Users[\\/]+(?!<|\{|\$|%|\*|Public\b|Default\b|name\b|user(?:name)?\b)[^\\/\s'"`<>]+/i],
  ['unix home path', /(?:^|[\s'"`(=])\/(?:home|Users)\/(?!<|\{|\$|\*|name\b|user(?:name)?\b)[A-Za-z0-9._-]+\//],
  ['dsh profile path', /\.dsh[\\/]+(?:profiles|dsh-runtimes)[\\/]/i],
  ['api key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['bearer token', /\bBearer\s+(?!<|\$|\{|token\b|key\b|xxx|\.\.\.)[A-Za-z0-9._~+/-]{20,}=*/],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['cloud access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['env credential', /^\s*[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)\s*=\s*[^\s#'"$<{][^\s#]{7,}/m],
]
// The lookbehind keeps URL user info (`https://user:pass@host`) from reading as an address.
const MAIL = /(?<![A-Za-z0-9._%+:/-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** A line carrying this marker is a deliberate fake fixture, e.g. a redaction test input. */
const ALLOW = 'privacy-scan: allow'

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(directory, entry.name))
    } else if (entry.isFile()) yield join(directory, entry.name)
  }
}

const findings = []
let scanned = 0
for (const file of walk(root)) {
  const name = relative(root, file).split(sep).join('/')
  if (SKIP_FILES.has(name) || !TEXT.test(name.split('/').at(-1)) || statSync(file).size > MAX_BYTES) continue
  scanned++
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.includes(ALLOW)) return
    for (const [label, pattern] of RULES) {
      if (pattern.test(line)) findings.push(`${name}:${index + 1}  ${label}`)
    }
    for (const mail of line.match(MAIL) ?? []) {
      if (!SAFE_MAIL_HOST.test(mail)) findings.push(`${name}:${index + 1}  e-mail address`)
    }
  })
}

if (findings.length > 0) {
  console.error(`privacy scan: ${findings.length} finding(s) in ${scanned} files`)
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}
console.log(`privacy scan: clean (${scanned} files)`)
