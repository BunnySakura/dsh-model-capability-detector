/** Preserve original-provider records rather than merging reseller limits.
 * models.dev is a community mirror, not a first-party API. The allowlist is
 * deliberately explicit; unknown publishers never become an original vendor.
 */
import { readFileSync } from 'node:fs'

import { capabilitiesOf, normalizeLevel, effortsFromLevels } from './detect.js'
import { nameKeys } from './names.js'

/**
 * The trusted publishers live in data/vendors.json so that adding one is a
 * data-only change. A row names the models.dev provider, the vendor namespace
 * its models belong to (several providers can share one), the documentation
 * hosts that prove the entry is first-party (`host` or `host/path-prefix`), and
 * optionally a pattern the model ids must match when the entry carries no
 * `canonical_model_id`.
 */
const DOC_SPEC = /^[a-z0-9.-]+(?:\/[a-z0-9._~/-]*)?$/i

export function readVendors(file = new URL('../data/vendors.json', import.meta.url)) {
  let rows
  try { rows = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (row === null || typeof row !== 'object' || typeof row.vendor !== 'string' || typeof row.provider !== 'string' || !Array.isArray(row.docs)) return []
    const docs = row.docs.filter((spec) => typeof spec === 'string' && DOC_SPEC.test(spec)).map((spec) => {
      const slash = spec.indexOf('/')
      return slash < 0 ? { host: spec.toLowerCase(), prefix: '' } : { host: spec.slice(0, slash).toLowerCase(), prefix: spec.slice(slash).replace(/\/+$/, '') }
    })
    if (docs.length === 0) return []
    let models
    if (typeof row.models === 'string') {
      try { models = new RegExp(row.models, 'i') } catch { return [] }
    }
    return [{ vendor: row.vendor.toLowerCase(), provider: row.provider, docs, models }]
  })
}

const VENDOR_ROWS = Object.freeze(readVendors())

function officialDoc(provider, row) {
  try {
    const url = new URL(provider?.doc)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    const path = url.pathname.replace(/\/+$/, '')
    const trusted = row.docs.some(({ host, prefix }) => url.hostname === host
      && (prefix === '' || path === prefix || path.startsWith(`${prefix}/`)))
    return trusted ? `${url.origin}${url.pathname}` : undefined
  } catch { return undefined }
}

// Retain punctuation and version suffixes. Only cosmetic case/space is folded.
const exactKey = (id) => typeof id === 'string' ? id.trim().toLowerCase() : ''
const leaf = (id) => exactKey(id).split('/').at(-1)

export function buildOfficialRecords(catalog, rows = VENDOR_ROWS) {
  const records = []
  for (const row of rows) {
    const provider = catalog?.[row.provider]
    const vendor = row.vendor
    const doc = officialDoc(provider, row)
    if (doc === undefined || provider?.id !== row.provider) continue
    for (const [mapId, model] of Object.entries(provider.models ?? {})) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue
      const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id : undefined
      // A vendor can host another company's model: it is not an original record.
      if (canonical !== undefined && !canonical.toLowerCase().startsWith(`${vendor}/`)) continue
      // Without a canonical id only the vendor's own naming proves the model is theirs.
      if (canonical === undefined && row.models !== undefined && !row.models.test(mapId)) continue
      const caps = capabilitiesOf(model, mapId)
      if (caps === undefined) continue
      const levels = new Set()
      for (const option of Array.isArray(model.reasoning_options) ? model.reasoning_options : []) {
        if (option?.type !== 'effort') continue
        for (const raw of Array.isArray(option.values) ? option.values : []) {
          const level = normalizeLevel(raw)
          if (level !== undefined) levels.add(level)
        }
      }
      // A documented toggle plus explicit effort levels supports an off entry.
      if (levels.size && model.reasoning_options.some((option) => option?.type === 'toggle')) levels.add('off')
      const efforts = effortsFromLevels(levels)
      if (efforts !== undefined) caps.reasoningEfforts = efforts
      const { id, name, hints, ...safe } = caps
      // Whether the model reasons at all, kept apart from the level dictionary:
      // a toggle or a token budget says "reasons" without naming any level.
      const reasons = efforts !== undefined ? true : model.reasoning === true ? true : model.reasoning === false ? false : undefined
      records.push({ vendor, id, canonical, doc, safe, ...reasons === undefined ? {} : { reasons },
        updated: typeof model.last_updated === 'string' ? model.last_updated : undefined })
    }
  }
  return records
}

// Records checked by hand against the publisher's release, a pinned weight
// config and the API reference live in data/verified.json (see docs/data-sources.md
// for the admission rules). Do not extend floating aliases to a different snapshot.
const readVerified = () => {
  try {
    const rows = JSON.parse(readFileSync(new URL('../data/verified.json', import.meta.url), 'utf8'))
    return Array.isArray(rows)
      ? rows.filter((row) => row && typeof row.id === 'string' && typeof row.vendor === 'string'
        && row.safe !== null && typeof row.safe === 'object').map((row) => Object.freeze({ ...row, direct: true }))
      : []
  } catch { return [] }
}
export const VERIFIED = Object.freeze(readVerified())

/**
 * A trailing snapshot tag: `-20241022`, `-2024-12-17`, or a four-digit `-MMDD`
 * (`-0731`, `-1017`). The four-digit form must read as a real month and day, so
 * version-like suffixes such as `-2507` are not mistaken for snapshots.
 */
const SNAPSHOT_TAG = /[-_.](?:20\d{2}-?(?:0[1-9]|1[0-2])-?(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/
const compactLeaf = (id) => leaf(id).replace(/:[a-z0-9._-]+$/, '').replace(/[^a-z0-9]/g, '')

/**
 * Inherit one capability from the dated snapshots of an unpinned name.
 *
 * `deepseek-v4.1-flash` names a model line, `deepseek-v4.1-flash-1017` one
 * snapshot of it. Numeric limits can change between snapshots, so they are never
 * shared. Whether a line reasons, and with which levels, is a property of the
 * line; it is inherited only when every snapshot that states it agrees, and only
 * for a requested name that carries no snapshot tag of its own.
 * @returns `{ value, source }`, or `undefined` when there is nothing safe to inherit.
 */
export function resolveSibling(records, requested, field = 'reasoningEfforts') {
  const key = exactKey(requested)
  const wanted = compactLeaf(key)
  if (wanted.length < 4 || SNAPSHOT_TAG.test(leaf(key).replace(/:[a-z0-9._-]+$/, ''))) return undefined
  const rows = [...VERIFIED, ...(Array.isArray(records) ? records : [])]
  const siblings = rows.filter((row) => {
    const name = leaf(row.id).replace(/:[a-z0-9._-]+$/, '')
    return SNAPSHOT_TAG.test(name) && compactLeaf(name.replace(SNAPSHOT_TAG, '')) === wanted
  })
  const vendors = new Set(siblings.map((row) => row.vendor))
  if (vendors.size !== 1) return undefined
  const disclosed = siblings.filter((row) => row.safe?.[field] !== undefined)
  const values = new Map(disclosed.map((row) => [JSON.stringify(row.safe[field]), row.safe[field]]))
  if (values.size !== 1) return undefined
  return {
    value: structuredClone(values.values().next().value),
    source: {
      kind: 'official-sibling', vendor: [...vendors][0], match: 'sibling',
      models: [...new Set(disclosed.map((row) => row.canonical ?? row.id))],
      urls: [...new Set(disclosed.flatMap((row) => [row.doc, ...(row.urls ?? [])]))],
      channelVerified: false,
    },
  }
}

export function resolveOfficial(records, requested) {
  const key = exactKey(requested)
  if (!key) return { status: 'unknown', reason: 'empty model id' }
  const pinned = VERIFIED.filter((row) => [row.id, row.canonical].some((id) => exactKey(id) === key || leaf(id) === key))
  const all = pinned.length ? pinned : Array.isArray(records) ? records : []
  // A canonical identity is only admitted when it occurs on an original record.
  let matches = all.filter((row) => [row.id, row.canonical, `${row.vendor}/${row.id}`].some((id) => exactKey(id) === key))
  let match = 'exact'
  if (!matches.length) {
    matches = all.filter((row) => [row.id, row.canonical].some((id) => leaf(id) === leaf(key)))
    match = 'leaf'
  }
  if (!matches.length) {
    // Gateway decoration or a dated snapshot of a documented model: accepted only
    // when every matching original record agrees (checked below).
    const family = nameKeys(key).family
    matches = all.filter((row) => [row.id, row.canonical].some((id) => id && nameKeys(id).family === family))
    match = 'family'
  }
  if (!matches.length) return { status: 'unknown', reason: 'no exact original-provider model record' }
  const identities = new Set(matches.map((row) => exactKey(row.canonical ?? `${row.vendor}/${row.id}`)))
  if (identities.size !== 1) return { status: 'ambiguous', reason: 'original-provider identities disagree' }
  const safe = {}, withheld = {}, sources = {}
  for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
    const disclosed = matches.filter((row) => row.safe?.[field] !== undefined)
    const values = new Map(disclosed.map((row) => [JSON.stringify(row.safe[field]), row.safe[field]]))
    if (values.size > 1) { withheld[field] = [...values.values()]; continue }
    if (values.size === 1) {
      safe[field] = structuredClone(values.values().next().value)
      sources[field] = { kind: matches[0].direct ? 'official-verified' : 'original-provider-mirror', vendor: matches[0].vendor,
        model: matches[0].canonical ?? matches[0].id, urls: [...new Set(disclosed.flatMap((row) => [row.doc, ...(row.urls ?? [])]))],
        verifiedAt: matches[0].direct ? matches[0].updated : null, channelVerified: false }
    }
  }
  // Whether the model reasons at all: the original records must agree. A
  // disagreement or silence leaves the question open instead of guessing.
  const verdicts = new Set(matches.map((row) => row.reasons
    ?? (row.safe?.reasoningEfforts === false ? false : row.safe?.reasoningEfforts !== undefined ? true : undefined))
    .filter((verdict) => verdict !== undefined))
  const reasons = verdicts.size === 1 ? [...verdicts][0] : undefined
  return { status: 'resolved', match, identity: [...identities][0], entries: matches.length, safe, withheld, sources,
    ...reasons === undefined ? {} : { reasons },
    numericDecisions: Object.fromEntries(['contextWindow', 'maxTokens'].filter((field) => safe[field] !== undefined)
      .map((field) => [field, { strategy: 'official', value: safe[field], estimated: false }])) }
}
