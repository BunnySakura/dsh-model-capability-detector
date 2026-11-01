/**
 * Plugin-owned settings: defaults, validation and a small revisioned store.
 *
 * Layers, lowest to highest priority: built-in defaults, the row's patch
 * `config`, then GUI overrides saved in `<DSH home>/model-capability-detector/settings.json`.
 * Resetting a field removes its override, so it falls back to the layer below.
 * The file holds no credentials, only the options listed in `FIELDS`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CACHE_TTL_MS } from './catalog.js'
import { writeFileAtomic } from './fsutil.js'

const NAMESPACE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const STRATEGIES = ['official', 'minimum', 'consensus']

/** Single source of truth shared by the Host, the GUI and the tests. */
export const FIELDS = {
  enabled: { type: 'boolean', default: true },
  settingsNs: { type: 'string', default: 'llm-pi-ai', max: 64, pattern: NAMESPACE },
  discoveryTrigger: { type: 'boolean', default: true },
  timeoutMs: { type: 'integer', default: 15000, min: 1, max: 600000 },
  debounceMs: { type: 'integer', default: 800, min: 0, max: 60000 },
  startupDelayMs: { type: 'integer', default: 3000, min: 0, max: 3600000 },
  maxResponseBytes: { type: 'integer', default: 4 * 1024 * 1024, min: 1024, max: Number.MAX_SAFE_INTEGER },
  catalogFallback: { type: 'boolean', default: true },
  catalogUrl: { type: 'url', default: 'https://models.dev/api.json', max: 2048 },
  catalogTimeoutMs: { type: 'integer', default: 30000, min: 1, max: 600000 },
  catalogMaxBytes: { type: 'integer', default: 16 * 1024 * 1024, min: 1024, max: Number.MAX_SAFE_INTEGER },
  catalogTtlMs: { type: 'integer', default: DEFAULT_CACHE_TTL_MS, min: 0, max: Number.MAX_SAFE_INTEGER },
  catalogNumbers: { type: 'boolean', default: true },
  catalogNumericStrategy: { type: 'enum', default: 'official', values: STRATEGIES },
  thirdPartySources: { type: 'boolean', default: true },
  upgradeWritten: { type: 'boolean', default: true },
  modelAliases: { type: 'aliases', default: {}, max: 64 },
  overwrite: { type: 'boolean', default: false },
  dryRun: { type: 'boolean', default: false },
  logging: { type: 'boolean', default: false },
  logFile: { type: 'path', default: '', max: 512 },
  updateCheckOnStartup: { type: 'boolean', default: false },
}

export const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field.type === 'aliases' ? {} : field.default])))

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

/** A relative path must stay under DSH home; `~/` is accepted as that home. */
function insideHome(path) {
  if (path === '' || path === '~') return true
  if (/^[a-z]:|^[\\/]{2}/i.test(path)) return false
  const rest = path.replace(/^~[\\/]/, '')
  if (/^[\\/]/.test(rest)) return false
  return !rest.split(/[\\/]+/).includes('..')
}

/**
 * Validate one value. `strict` applies the extra rules that only the GUI
 * enforces: a log file may not leave DSH home.
 * @returns `{ ok: true, value }` or `{ ok: false }`.
 */
export function validateField(key, value, { strict = false } = {}) {
  if (!own(FIELDS, key)) return { ok: false }
  const field = FIELDS[key]
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false }
    case 'integer':
      return Number.isSafeInteger(value) && value >= field.min && value <= field.max ? { ok: true, value } : { ok: false }
    case 'enum':
      return field.values.includes(value) ? { ok: true, value } : { ok: false }
    case 'string': {
      const text = typeof value === 'string' ? value.trim() : undefined
      return text !== undefined && text.length > 0 && text.length <= field.max && field.pattern.test(text)
        ? { ok: true, value: text } : { ok: false }
    }
    case 'url': {
      if (typeof value !== 'string' || value.length === 0 || value.length > field.max) return { ok: false }
      try {
        const url = new URL(value.trim())
        const web = url.protocol === 'https:' || url.protocol === 'http:'
        return web && url.username === '' && url.password === '' ? { ok: true, value: url.toString() } : { ok: false }
      } catch { return { ok: false } }
    }
    case 'aliases': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
      const entries = Object.entries(value)
      if (entries.length > field.max) return { ok: false }
      const clean = {}
      for (const [from, to] of entries) {
        const left = from.trim().toLowerCase()
        const right = typeof to === 'string' ? to.trim() : ''
        // eslint-disable-next-line no-control-regex
        if (!left || !right || left.length > 128 || right.length > 128 || /[\u0000-\u001f]/.test(left + right)) return { ok: false }
        clean[left] = right
      }
      return { ok: true, value: clean }
    }
    case 'path': {
      if (typeof value !== 'string' || value.length > field.max || value.includes('\0')) return { ok: false }
      const text = value.trim()
      return strict && !insideHome(text) ? { ok: false } : { ok: true, value: text }
    }
    default:
      return { ok: false }
  }
}

/** Keep valid known keys; report the rest instead of throwing. */
export function normalizeLayer(raw, options) {
  const values = {}
  const invalid = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { values, invalid }
  for (const key of Object.keys(FIELDS)) {
    if (!own(raw, key) || raw[key] === undefined) continue
    const checked = validateField(key, raw[key], options)
    if (checked.ok) values[key] = checked.value
    else invalid.push(key)
  }
  return { values, invalid }
}

/** JSON-safe description of limits for the GUI; no function or RegExp leaks. */
export function describeFields() {
  return Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, {
    type: field.type,
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.values === undefined ? {} : { values: [...field.values] }),
  }]))
}

const revisionOf = (overrides) => createHash('sha256')
  .update(JSON.stringify(Object.keys(overrides).sort().map((key) => [key, overrides[key]])))
  .digest('hex').slice(0, 16)

/**
 * @param options.home DSH home directory; without it the store is read-only.
 * @param options.patch the row's configuration object.
 * @param options.onInvalid called with the patch keys that failed validation.
 */
export function createSettingsStore({ home, patch, onInvalid } = {}) {
  const file = typeof home === 'string' && home.length > 0 ? join(home, 'model-capability-detector', 'settings.json') : undefined
  const layer = normalizeLayer(patch)
  if (layer.invalid.length > 0) onInvalid?.(layer.invalid)
  const inherited = Object.freeze({ ...DEFAULTS, ...layer.values })
  const listeners = new Set()
  let overrides = {}
  let revision = revisionOf(overrides)
  let queue = Promise.resolve()

  const compute = () => Object.freeze({ ...inherited, ...overrides })
  let effective = compute()

  const readFile = () => {
    if (file === undefined) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return normalizeLayer(parsed?.overrides).values
    } catch { return {} }
  }
  const commit = (next) => {
    const previous = effective
    overrides = next
    revision = revisionOf(overrides)
    effective = compute()
    if (JSON.stringify(previous) !== JSON.stringify(effective)) {
      for (const listener of [...listeners]) {
        try { listener(effective, previous) } catch { /* a subscriber must not break saving */ }
      }
    }
  }
  const snapshot = () => ({
    revision,
    writable: file !== undefined,
    defaults: { ...inherited },
    overrides: { ...overrides },
    effective: { ...effective },
    fields: describeFields(),
  })
  commit(readFile())

  const persist = (next) => writeFileAtomic(file, `${JSON.stringify({ version: 1, overrides: next }, null, 2)}\n`)

  return {
    effective: () => effective,
    snapshot,
    /** Re-read the file, so an edit made outside the GUI is also followed. */
    refresh() {
      const next = readFile()
      if (revisionOf(next) !== revision) commit(next)
      return snapshot()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Apply one atomic change set against the revision the caller saw. */
    update(input) {
      const run = async () => {
        if (file === undefined) return { ok: false, reason: 'read-only', snapshot: snapshot() }
        const current = readFile()
        if (revisionOf(current) !== revision) commit(current)
        if (input?.revision !== revision) return { ok: false, reason: 'conflict', snapshot: snapshot() }
        const set = input.set !== null && typeof input.set === 'object' && !Array.isArray(input.set) ? input.set : {}
        const unset = Array.isArray(input.unset) ? input.unset : []
        const errors = []
        const next = { ...overrides }
        for (const key of Object.keys(set)) {
          const checked = validateField(key, set[key], { strict: true })
          if (checked.ok) next[key] = checked.value
          else errors.push(key)
        }
        for (const key of unset) {
          if (typeof key === 'string' && own(FIELDS, key)) Reflect.deleteProperty(next, key)
          else errors.push(String(key).slice(0, 64))
        }
        if (errors.length > 0) return { ok: false, reason: 'invalid', errors, snapshot: snapshot() }
        try { await persist(next) } catch { return { ok: false, reason: 'write-failed', snapshot: snapshot() } }
        commit(next)
        return { ok: true, snapshot: snapshot() }
      }
      const result = queue.then(run, run)
      queue = result.then(() => {}, () => {})
      return result
    },
  }
}
