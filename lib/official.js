/** Preserve original-provider records rather than merging reseller limits.
 * models.dev is a community mirror, not a first-party API. The allowlist is
 * deliberately explicit; unknown publishers never become an original vendor.
 */
import { capabilitiesOf, normalizeLevel, effortsFromLevels } from './detect.js'
import { nameKeys } from './names.js'

const VENDORS = {
  deepseek: ['api-docs.deepseek.com'],
  openai: ['platform.openai.com', 'developers.openai.com'],
  anthropic: ['docs.anthropic.com', 'platform.claude.com', 'docs.claude.com'],
  google: ['ai.google.dev'],
  xai: ['docs.x.ai'],
  mistral: ['docs.mistral.ai'],
  cohere: ['docs.cohere.com'],
  moonshotai: ['platform.moonshot.ai', 'platform.moonshot.cn'],
  zhipuai: ['docs.bigmodel.cn', 'open.bigmodel.cn'],
}

function officialDoc(provider, key) {
  try {
    const url = new URL(provider?.doc)
    return url.protocol === 'https:' && !url.username && !url.password
      && VENDORS[key]?.includes(url.hostname) ? `${url.origin}${url.pathname}` : undefined
  } catch { return undefined }
}

// Retain punctuation and version suffixes. Only cosmetic case/space is folded.
const exactKey = (id) => typeof id === 'string' ? id.trim().toLowerCase() : ''
const leaf = (id) => exactKey(id).split('/').at(-1)

export function buildOfficialRecords(catalog) {
  const records = []
  for (const [vendor, provider] of Object.entries(catalog ?? {})) {
    const doc = officialDoc(provider, vendor)
    if (doc === undefined || provider?.id !== vendor) continue
    for (const [mapId, model] of Object.entries(provider.models ?? {})) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue
      const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id : undefined
      // A vendor can host another company's model: it is not an original record.
      if (canonical !== undefined && !canonical.toLowerCase().startsWith(`${vendor}/`)) continue
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
      records.push({ vendor, id, canonical, doc, safe,
        updated: typeof model.last_updated === 'string' ? model.last_updated : undefined })
    }
  }
  return records
}

// Verified 2026-10-31 against the publisher's release, pinned weight config,
// and API reference. Do not extend floating aliases to a different snapshot.
const VERIFIED = [{
  vendor: 'deepseek', id: 'deepseek-v4.1-flash-1017', canonical: 'deepseek/deepseek-v4.1-flash-1017',
  doc: 'https://api-docs.deepseek.com/news/news261017',
  urls: ['https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json',
    'https://api-docs.deepseek.com/api/create-chat-completion/'],
  safe: { contextWindow: 1048576, maxTokens: 393216, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
  updated: '2026-10-31', direct: true,
}]

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
  return { status: 'resolved', match, identity: [...identities][0], entries: matches.length, safe, withheld, sources,
    numericDecisions: Object.fromEntries(['contextWindow', 'maxTokens'].filter((field) => safe[field] !== undefined)
      .map((field) => [field, { strategy: 'official', value: safe[field], estimated: false }])) }
}
