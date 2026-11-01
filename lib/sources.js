/**
 * Third-party public sources: OpenRouter's model list and LiteLLM's context
 * table. They are fixed public URLs fetched without credentials or any user
 * data. Each source is reduced to a compact index and cached; a value is only
 * ever used when at least two sources agree (see `tiers.js`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { positiveInteger } from './detect.js'
import { readJsonResponse } from './http.js'
import { nameKeys } from './names.js'

export const THIRD_PARTY_VERSION = 1
export const SOURCES = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', maxBytes: 8 * 1024 * 1024 },
  litellm: { url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', maxBytes: 12 * 1024 * 1024 },
}

const CHAT_MODES = new Set(['chat', 'responses', 'completion'])

function imageOf(modalities) {
  if (!Array.isArray(modalities) || modalities.length === 0) return undefined
  const names = modalities.map((item) => String(item).toLowerCase())
  if (names.some((name) => name === 'image' || name === 'vision' || name.startsWith('image/'))) return true
  return names.includes('text') ? false : undefined
}

/** Row = { c: context, o: output, i: accepts images, p: primary listing }. */
const compactRow = (c, o, i, p) => ({
  ...(c === undefined ? {} : { c }), ...(o === undefined ? {} : { o }), ...(i === undefined ? {} : { i }), p,
})

function openrouterRows(body) {
  const rows = []
  for (const entry of Array.isArray(body?.data) ? body.data : []) {
    if (typeof entry?.id !== 'string') continue
    rows.push({
      id: entry.id,
      row: compactRow(
        positiveInteger(entry.context_length, entry.top_provider?.context_length),
        positiveInteger(entry.top_provider?.max_completion_tokens),
        imageOf(entry.architecture?.input_modalities),
        !entry.id.includes(':'),
      ),
    })
  }
  return rows
}

function litellmRows(body) {
  const rows = []
  if (body === null || typeof body !== 'object') return rows
  for (const [id, entry] of Object.entries(body)) {
    if (id === 'sample_spec' || entry === null || typeof entry !== 'object') continue
    if (entry.mode !== undefined && !CHAT_MODES.has(entry.mode)) continue
    rows.push({
      id,
      row: compactRow(
        positiveInteger(entry.max_input_tokens),
        positiveInteger(entry.max_output_tokens, entry.max_tokens),
        // LiteLLM omits the flag for text-only models, so only `true` is a statement.
        entry.supports_vision === true ? true : undefined,
        !id.includes('/'),
      ),
    })
  }
  return rows
}

const READERS = { openrouter: openrouterRows, litellm: litellmRows }

/** Index one source by compact and family name. */
export function buildSourceIndex(name, body) {
  const compact = new Map()
  const family = new Map()
  const push = (map, key, row) => {
    if (key.length === 0) return
    const list = map.get(key)
    if (list === undefined) map.set(key, [row])
    else list.push(row)
  }
  for (const { id, row } of READERS[name](body)) {
    if (row.c === undefined && row.o === undefined && row.i === undefined) continue
    const keys = nameKeys(id)
    push(compact, keys.compact, row)
    push(family, keys.family, row)
  }
  if (compact.size === 0) return undefined
  return { compact: [...compact], family: [...family] }
}

/** Rehydrate a stored source index into lookup maps. */
export function toSourceLookup(index) {
  return { compact: new Map(index?.compact ?? []), family: new Map(index?.family ?? []) }
}

/** Numbers within this relative spread count as the same value. */
export const TOLERANCE = 0.05

/**
 * Pick the value most items agree on.
 *
 * Numbers within `tolerance` of the smallest member of a cluster are one
 * cluster, and the cluster's value is its smallest member, so a limit is never
 * overstated. The largest cluster wins when it is strictly larger than the next;
 * a tie returns `undefined`. Other values must match exactly.
 * @param items `[{ value, ... }]`
 * @returns `{ value, members }` or `undefined`.
 */
export function pickAgreed(items, tolerance = TOLERANCE) {
  if (items.length === 0) return undefined
  let clusters
  if (items.every((item) => typeof item.value === 'number')) {
    clusters = []
    for (const item of [...items].sort((a, b) => a.value - b.value)) {
      const last = clusters.at(-1)
      if (last !== undefined && item.value <= last.value * (1 + tolerance)) last.members.push(item)
      else clusters.push({ value: item.value, members: [item] })
    }
  } else {
    const groups = new Map()
    for (const item of items) {
      const id = JSON.stringify(item.value)
      const group = groups.get(id) ?? { value: item.value, members: [] }
      group.members.push(item)
      groups.set(id, group)
    }
    clusters = [...groups.values()]
  }
  clusters.sort((a, b) => b.members.length - a.members.length)
  if (clusters.length > 1 && clusters[0].members.length === clusters[1].members.length) return undefined
  return { value: clusters[0].value, members: clusters[0].members }
}

/** One field's vote from a list of rows: the agreed value, 'conflict' on a tie, or undefined. */
function settle(rows, key) {
  const preferred = rows.filter((row) => row.p)
  const pool = preferred.length > 0 ? preferred : rows
  const items = pool.filter((row) => row[key] !== undefined).map((row) => ({ value: row[key] }))
  if (items.length === 0) return undefined
  return pickAgreed(items)?.value ?? 'conflict'
}

/**
 * Votes of one source for a requested name.
 * @returns `{ match, context, output, image }` or `undefined` when unlisted.
 */
export function voteFor(lookup, requested) {
  if (lookup === undefined) return undefined
  const keys = nameKeys(requested)
  let match = 'compact'
  let rows = lookup.compact.get(keys.compact)
  if (rows === undefined) { match = 'family'; rows = lookup.family.get(keys.family) }
  if (rows === undefined || rows.length === 0) return undefined
  return { match, context: settle(rows, 'c'), output: settle(rows, 'o'), image: settle(rows, 'i') }
}

export const thirdPartyCachePath = (homePath) => join(homePath, 'cache', 'model-capability-detector', 'thirdparty.json')

async function readStored(homePath) {
  try {
    const parsed = JSON.parse(await readFile(thirdPartyCachePath(homePath), 'utf8'))
    return parsed?.version === THIRD_PARTY_VERSION && parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {}
  } catch { return {} }
}

async function download(name, { timeoutMs, signal }) {
  const controller = new AbortController()
  const relay = () => controller.abort(signal?.reason)
  if (signal?.aborted) relay()
  else signal?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('timed out')), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(SOURCES[name].url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'follow' })
    if (!response.ok) { await response.body?.cancel(); return undefined }
    return buildSourceIndex(name, await readJsonResponse(response, SOURCES[name].maxBytes))
  } catch { return undefined } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}

/**
 * Load both sources, reusing fresh cache and tolerating partial failure.
 * @returns `{ lookups, status }`; a failed source is simply absent.
 */
export async function loadThirdParty({ homePath, ttlMs, timeoutMs, signal, now = Date.now() }) {
  const stored = typeof homePath === 'string' ? await readStored(homePath) : {}
  const lookups = {}
  const status = {}
  const fresh = {}
  let changed = false
  await Promise.all(Object.keys(SOURCES).map(async (name) => {
    const cached = stored[name]
    if (cached?.index && typeof cached.fetchedAt === 'number' && cached.fetchedAt <= now && now - cached.fetchedAt < ttlMs) {
      lookups[name] = toSourceLookup(cached.index)
      fresh[name] = cached
      status[name] = 'cache'
      return
    }
    const index = await download(name, { timeoutMs, signal })
    if (index !== undefined) {
      lookups[name] = toSourceLookup(index)
      fresh[name] = { fetchedAt: now, index }
      status[name] = 'network'
      changed = true
    } else if (cached?.index) {
      lookups[name] = toSourceLookup(cached.index)
      fresh[name] = cached
      status[name] = 'stale-cache'
    } else status[name] = 'failed'
  }))
  if (changed && typeof homePath === 'string') {
    try {
      await mkdir(join(homePath, 'cache', 'model-capability-detector'), { recursive: true })
      await writeFile(thirdPartyCachePath(homePath), JSON.stringify({ version: THIRD_PARTY_VERSION, sources: fresh }), 'utf8')
    } catch { /* The cache is an optimization. */ }
  }
  return { lookups, status }
}
