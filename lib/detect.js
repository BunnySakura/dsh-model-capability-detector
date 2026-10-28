/**
 * Pure capability-detection helpers.
 *
 * Every function here is a total function over unknown JSON: gateway model
 * listings disagree on field names, nesting, and even on whether a capability
 * is a flag, a list, or a string. Detection reads all of those spellings and
 * reports `undefined` when an endpoint discloses nothing, so the caller can
 * leave a field alone instead of guessing.
 *
 * @module dsh-model-capability-detector/detect
 */

/** pi-ai's thinking levels, in escalation order. */
export const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Vendor spellings accepted for each level. */
const LEVEL_ALIASES = new Map([
  ['off', 'off'],
  ['none', 'off'],
  ['no_think', 'off'],
  ['nothink', 'off'],
  ['disabled', 'off'],
  ['disable', 'off'],
  ['false', 'off'],
  ['minimal', 'minimal'],
  ['minimum', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['mid', 'medium'],
  ['moderate', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['x-high', 'xhigh'],
  ['extra_high', 'xhigh'],
  ['extra-high', 'xhigh'],
  ['extrahigh', 'xhigh'],
  ['max', 'max'],
  ['maximum', 'max'],
  ['ultra', 'max'],
])

/** First positive integer among the candidates; numeric strings are accepted. */
export function positiveInteger(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return candidate
    if (typeof candidate === 'string' && /^[1-9][0-9]*$/.test(candidate.trim())) {
      const parsed = Number(candidate.trim())
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    }
  }
  return undefined
}

/** First non-empty string among the candidates. */
export function textOf(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/** Normalize one modality list into the pi-ai `text` / `image` vocabulary. */
function modalitySet(raw) {
  if (!Array.isArray(raw)) return undefined
  const found = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim().toLowerCase()
    if (value === 'text') found.add('text')
    else if (value === 'image' || value === 'vision' || value === 'image_url') found.add('image')
    else if (value.startsWith('image/')) found.add('image')
  }
  return found.size === 0 ? undefined : found
}

/** Map one vendor level name onto a pi-ai level, or `undefined` when unknown. */
export function normalizeLevel(raw) {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_')
  return LEVEL_ALIASES.get(key) ?? LEVEL_ALIASES.get(key.replace(/_/g, '-'))
}

/**
 * Collect known levels from any listing shape that names them: an array, a
 * JSON-Schema `{ enum }`, a dict of enabled flags, or a nested wrapper.
 * @returns the recognized levels in pi-ai escalation order, so a caller can
 *   compare two listings without depending on the order each vendor listed.
 */
export function normalizeLevels(source) {
  if (source === undefined || source === null) return undefined
  let values
  if (Array.isArray(source)) values = source
  else if (typeof source === 'object') {
    for (const key of ['enum', 'values', 'levels', 'options', 'allowed']) {
      if (Array.isArray(source[key])) return normalizeLevels(source[key])
    }
    values = Object.entries(source)
      .filter(([, enabled]) => enabled !== false && enabled !== null)
      .map(([key]) => key)
  } else return undefined
  const named = new Set()
  for (const value of values) {
    const level = normalizeLevel(value)
    if (level !== undefined) named.add(level)
  }
  if (named.size === 0) return undefined
  return new Set(LEVEL_ORDER.filter((level) => named.has(level)))
}

/**
 * Turn discovered levels into pi-ai's `reasoningEfforts` dict.
 * @returns the dict, or `undefined` when the model offers no think-on level.
 */
export function effortsFromLevels(levels) {
  const offered = LEVEL_ORDER.filter((level) => levels.has(level))
  if (!offered.some((level) => level !== 'off')) return undefined
  return Object.fromEntries(offered.map((level) => [level, level === 'off' ? null : level]))
}

/**
 * Detect the input modalities one listing entry supports.
 * @returns `['text','image']`, `['text']`, or `undefined` when it says nothing.
 */
export function detectInput(entry) {
  const lists = [
    entry?.architecture?.input_modalities,
    entry?.input_modalities,
    entry?.modalities?.input,
    entry?.input,
    entry?.capabilities?.modalities,
    entry?.supported_modalities,
  ]
  let sawList = false
  let sawImage = false
  for (const list of lists) {
    const set = modalitySet(list)
    if (set === undefined) continue
    sawList = true
    if (set.has('image')) sawImage = true
  }
  const truthy = [
    entry?.capabilities?.vision,
    entry?.capabilities?.image_input,
    entry?.capabilities?.images,
    entry?.supports_vision,
    entry?.supports_image_input,
    entry?.vision,
    entry?.image_input,
  ]
  if (truthy.some((flag) => flag === true)) return ['text', 'image']
  if (sawImage) return ['text', 'image']
  // The `text+image->text` string OpenRouter publishes for the same fact.
  const modality = entry?.architecture?.modality ?? entry?.modality
  if (typeof modality === 'string') {
    const value = modality.toLowerCase()
    if (value.includes('image')) return ['text', 'image']
    if (value.includes('text')) sawList = true
  }
  if (truthy.some((flag) => flag === false)) return ['text']
  return sawList ? ['text'] : undefined
}

/**
 * Detect reasoning support one listing entry discloses.
 * @returns pi-ai's `reasoningEfforts` value, or `undefined` when undisclosed.
 */
export function detectReasoning(entry) {
  const sources = [
    entry?.reasoning?.supported_efforts,
    entry?.reasoning?.efforts,
    entry?.reasoning?.levels,
    entry?.reasoning_efforts,
    entry?.reasoning_effort_levels,
    entry?.thinking_levels,
    entry?.supported_thinking_levels,
    entry?.capabilities?.reasoning_levels,
    entry?.capabilities?.reasoning?.efforts,
    entry?.capabilities?.reasoning?.levels,
    entry?.capabilities?.thinking_levels,
    entry?.parameters?.reasoning_effort?.enum,
    entry?.parameters?.reasoning?.enum,
  ]
  for (const source of sources) {
    const levels = normalizeLevels(source)
    const efforts = levels === undefined ? undefined : effortsFromLevels(levels)
    if (efforts !== undefined) return efforts
  }
  const negatives = [
    entry?.reasoning === false,
    entry?.capabilities?.reasoning === false,
    entry?.supports_reasoning === false,
    entry?.thinking === false,
  ]
  if (negatives.some(Boolean)) return false
  return undefined
}

/**
 * Normalize one listing entry into detached capabilities.
 * @param entry - one raw model record.
 * @param fallbackId - the model map key; it is the request id even when the
 *   record names a different canonical id.
 * @returns the capabilities, or `undefined` for a record without an id.
 */
export function capabilitiesOf(entry, fallbackId) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const id = textOf(fallbackId, entry.id, entry.model, entry.slug, entry.name)
  if (id === undefined) return undefined
  const contextWindow = positiveInteger(
    entry.contextWindow,
    entry.context_window,
    entry.context_length,
    entry.contextLength,
    entry.max_context_length,
    entry.max_model_len,
    entry.max_input_tokens,
    entry.limit?.context,
    entry.top_provider?.context_length,
    entry.capabilities?.context_window,
  )
  const maxTokens = positiveInteger(
    entry.maxOutputTokens,
    entry.max_output_tokens,
    entry.maxTokens,
    entry.max_tokens,
    entry.max_completion_tokens,
    entry.limit?.output,
    entry.top_provider?.max_completion_tokens,
    entry.capabilities?.max_output_tokens,
  )
  const input = detectInput(entry)
  const reasoningEfforts = detectReasoning(entry)
  const name = textOf(entry.name, entry.display_name, entry.displayName)
  return {
    id,
    ...name === undefined || name === id ? {} : { name },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { input },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
  }
}

/**
 * Read one listing body in any published shape.
 * @returns detached capabilities, deduplicated in endpoint order.
 */
export function readListing(body) {
  const listed = []
  if (Array.isArray(body?.data)) for (const entry of body.data) listed.push({ entry })
  else if (Array.isArray(body?.models)) for (const entry of body.models) listed.push({ entry })
  else if (body?.models !== null && typeof body?.models === 'object') {
    for (const [key, entry] of Object.entries(body.models)) listed.push({ entry, key })
  } else if (Array.isArray(body)) for (const entry of body) listed.push({ entry })
  else throw new Error('the model listing has neither a "data" array nor a "models" object')
  const found = []
  const seen = new Set()
  for (const { entry, key } of listed) {
    const capabilities = capabilitiesOf(entry, key)
    if (capabilities === undefined || seen.has(capabilities.id)) continue
    seen.add(capabilities.id)
    found.push(capabilities)
  }
  return found
}

/**
 * Join one configured route's base URL with its protocol's listing path.
 * @returns the URL and the protocol family, which decides the auth header.
 */
export function listingUrl(baseURL, api) {
  const base = new URL(baseURL)
  base.hash = ''
  const path = base.pathname.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') {
    base.pathname = `${path}/models`
    return { url: base.toString(), family: 'openai' }
  }
  const root = path.endsWith('/v1') ? path.slice(0, -3) : path
  base.pathname = `${root}/v1/models`
  base.searchParams.set('limit', '1000')
  return { url: base.toString(), family: 'anthropic' }
}

/** Build the request headers one protocol's listing expects. */
export function listingHeaders(family, apiKey, extra) {
  const headers = new Headers()
  headers.set('accept', 'application/json')
  for (const [header, value] of Object.entries(extra ?? {})) {
    if (typeof value === 'string' && value.length > 0) headers.set(header, value)
  }
  if (typeof apiKey === 'string' && apiKey.length > 0 && !headers.has('authorization') && !headers.has('x-api-key')) {
    if (family === 'anthropic') headers.set('x-api-key', apiKey)
    else headers.set('authorization', `Bearer ${apiKey}`)
  }
  if (family === 'anthropic' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
  return headers
}

/** Whether one configured field already carries a usable value. */
export function configured(value) {
  if (value === false) return true
  if (typeof value === 'number') return Number.isInteger(value) && value > 0
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

/**
 * Build the `settings.mutate` operations that fill one route's model rows.
 * @param route - provider route key.
 * @param profile - that route's configured profile.
 * @param detected - capabilities discovered for that route, keyed by model id.
 * @param overwrite - replace already-configured values instead of filling blanks.
 * @returns the path operations and a human-readable plan for logging.
 */
export function planRouteOps(route, profile, detected, overwrite) {
  const ops = []
  const plan = []
  const models = Array.isArray(profile?.models) ? profile.models : []
  models.forEach((model, index) => {
    if (model === null || typeof model !== 'object') return
    const id = typeof model.id === 'string' ? model.id : undefined
    if (id === undefined || id.length === 0) return
    const capabilities = detected.get(id)
    if (capabilities === undefined) return
    const base = ['providers', route, 'models', String(index)]
    const filled = []
    for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
      const value = capabilities[field]
      if (value === undefined) continue
      if (!overwrite && configured(model[field])) continue
      ops.push({ op: 'set', path: [...base, field], value })
      filled.push(`${field}=${JSON.stringify(value)}`)
    }
    if (filled.length > 0) plan.push(`${route}/${id}: ${filled.join(', ')}`)
  })
  return { ops, plan }
}
