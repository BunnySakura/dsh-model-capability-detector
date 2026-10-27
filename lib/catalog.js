/**
 * Fallback capability source: a public model catalog.
 *
 * When a provider's own model listing discloses nothing (common for resale
 * gateways that return only `id` and `object`), this module answers from a
 * public catalog keyed by model name.
 *
 * Two properties of that catalog decide the whole design:
 *
 * 1. **The same name means different things to different providers.** A resale
 *    gateway may serve a truncated context window under the vendor's model name.
 *    Measured across the catalog, entries sharing a name agree on input
 *    modalities 87% of the time and on reasoning levels 79%, but on the context
 *    window only 52% and on the output cap 47%. So a field is only answered when
 *    every entry carrying that name agrees; otherwise it is withheld with the
 *    competing values, and the caller leaves the configured value alone.
 *
 * 2. **Names vary by case, separator, and provider prefix.** `GPT-6.1-SOL`,
 *    `gpt_6_1_sol`, and `openai/gpt-6.1-sol` all name one model. Matching
 *    normalizes the provider prefix away and then keeps only lowercase
 *    alphanumerics, so every separator spelling collapses to one key.
 *
 * @module dsh-model-capability-detector/catalog
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { effortsFromLevels, normalizeLevel, positiveInteger } from './detect.js'

/** Cache format version; bump when the aggregate shape changes. */
export const CACHE_VERSION = 2

/**
 * Reduce a model name to its matching key.
 *
 * The provider prefix is dropped first because catalogs spell the same model as
 * `openai/gpt-6.1-sol` while a gateway advertises `gpt-6.1-sol`; keeping the
 * prefix would make every first-party name unmatchable.
 * @param name - a model id from any source.
 * @returns lowercase alphanumerics only, or an empty string.
 */
export function matchKey(name) {
  const text = String(name ?? '')
  const bare = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Append every value of `source` into `target` when `source` is an array. */
function addAll(target, source) {
  if (!Array.isArray(source)) return
  for (const value of source) target.add(value)
}

/**
 * Accumulate one catalog identity's disclosed capabilities.
 * @returns the aggregate for that identity.
 */
function emptyAggregate() {
  return {
    contexts: new Set(),
    outputs: new Set(),
    images: new Set(),
    levels: new Set(),
    nonReasoning: 0,
    reasoning: 0,
    entries: 0,
  }
}

/** Fold one models.dev model entry into its identity aggregate. */
function foldEntry(aggregate, model) {
  aggregate.entries += 1

  const limit = model?.limit
  if (limit !== null && typeof limit === 'object') {
    const context = positiveInteger(limit.context)
    if (context !== undefined) aggregate.contexts.add(context)
    const output = positiveInteger(limit.output)
    if (output !== undefined) aggregate.outputs.add(output)
  }

  const input = model?.modalities?.input
  if (Array.isArray(input)) {
    aggregate.images.add(input.some((value) => String(value).toLowerCase() === 'image'))
  }

  for (const option of Array.isArray(model?.reasoning_options) ? model.reasoning_options : []) {
    if (option?.type !== 'effort') continue
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const level = normalizeLevel(value)
      if (level !== undefined) aggregate.levels.add(level)
    }
  }

  // A model that offers levels reasons; one the catalog marks `reasoning: false`
  // does not. Both are recorded so the two can be compared for agreement.
  if (aggregate.levels.size > 0 || model?.reasoning === true) aggregate.reasoning += 1
  if (model?.reasoning === false) aggregate.nonReasoning += 1
}

/**
 * Build the two indexes the resolver needs from one catalog document.
 *
 * `groups` is keyed by identity so every spelling of one model accumulates into
 * a single aggregate. `reach` maps a normalized name to the identities it can
 * reach, which is what makes a name shared by two identities detectable instead
 * of silently resolved to whichever came first.
 * @param catalog - the parsed models.dev document.
 * @returns the serializable index, or `undefined` when nothing usable was found.
 */
export function buildIndex(catalog) {
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) return undefined
  const aggregates = new Map()
  const reach = new Map()
  let providers = 0
  let models = 0

  for (const provider of Object.values(catalog)) {
    const entries = provider?.models
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue
    providers += 1
    for (const model of Object.values(entries)) {
      if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
      const idKey = matchKey(model.id)
      if (idKey.length === 0) continue
      models += 1
      // The canonical id unifies a vendor's own entry with resale entries that
      // reuse the same name but spell it differently.
      const identity = matchKey(model.canonical_model_id) || idKey
      let aggregate = aggregates.get(identity)
      if (aggregate === undefined) {
        aggregate = emptyAggregate()
        aggregates.set(identity, aggregate)
      }
      foldEntry(aggregate, model)
      const names = reach.get(idKey)
      if (names === undefined) reach.set(idKey, [identity])
      else if (!names.includes(identity)) names.push(identity)
    }
  }

  if (aggregates.size === 0) return undefined
  return {
    version: CACHE_VERSION,
    providers,
    models,
    groups: [...aggregates].map(([identity, aggregate]) => [
      identity,
      {
        contexts: [...aggregate.contexts].sort((a, b) => a - b),
        outputs: [...aggregate.outputs].sort((a, b) => a - b),
        images: [...aggregate.images].sort(),
        levels: [...aggregate.levels].sort(),
        nonReasoning: aggregate.nonReasoning,
        reasoning: aggregate.reasoning,
        entries: aggregate.entries,
      },
    ]),
    reach: [...reach].map(([name, identities]) => [name, identities]),
  }
}

/** Rehydrate `buildIndex` output into lookup maps. */
export function toLookup(index) {
  return {
    groups: new Map(Array.isArray(index?.groups) ? index.groups : []),
    reach: new Map(Array.isArray(index?.reach) ? index.reach : []),
  }
}

/** Report one field's agreed value, or the competing values that prevent it. */
function settle(values, convert = (value) => value) {
  if (!Array.isArray(values) || values.length === 0) return { state: 'absent' }
  if (values.length === 1) return { state: 'agreed', value: convert(values[0]) }
  return { state: 'conflict', candidates: values }
}

/**
 * Answer one model name from the catalog index.
 *
 * `safe` holds fields that agreed everywhere; `withheld` names the fields that
 * either no entry disclosed or entries disagreed about, with the candidates, so
 * a reader can tell "no data" apart from "contradictory data".
 * @param lookup - the rehydrated index.
 * @param requested - the model id as the provider advertised it.
 * @returns the resolution, always with an explanation of what was decided.
 */
export function resolveName(lookup, requested) {
  const key = matchKey(requested)
  if (key.length === 0) return { status: 'unknown', reason: 'empty model name' }

  const identities = lookup.reach.get(key)
  if (identities === undefined || identities.length === 0) {
    return { status: 'unknown', reason: 'no catalog entry matches this name' }
  }
  if (identities.length > 1) {
    return {
      status: 'ambiguous',
      reason: `${identities.length} catalog identities share this name`,
      identities: [...identities].sort(),
    }
  }

  const identity = identities[0]
  const aggregate = lookup.groups.get(identity)
  if (aggregate === undefined) {
    return { status: 'unknown', reason: 'catalog identity has no capabilities' }
  }

  const safe = {}
  const withheld = {}

  const context = settle(aggregate.contexts)
  if (context.state === 'agreed') safe.contextWindow = context.value
  else if (context.state === 'conflict') withheld.contextWindow = context.candidates

  const output = settle(aggregate.outputs)
  if (output.state === 'agreed') safe.maxTokens = output.value
  else if (output.state === 'conflict') withheld.maxTokens = output.candidates

  const image = settle(aggregate.images)
  if (image.state === 'agreed') safe.input = image.value ? ['text', 'image'] : ['text']
  else if (image.state === 'conflict') withheld.input = image.candidates

  // Reasoning is reported three ways: an explicit level list, an explicit
  // "not a reasoning model", or nothing. Only an unambiguous answer is used.
  const levels = Array.isArray(aggregate.levels) ? aggregate.levels : []
  const reasons = aggregate.reasoning ?? 0
  const nonReasoning = aggregate.nonReasoning ?? 0
  if (levels.length > 0 && nonReasoning === 0) {
    const efforts = effortsFromLevels(new Set(levels))
    if (efforts !== undefined) safe.reasoningEfforts = efforts
  } else if (levels.length > 0 && nonReasoning > 0) {
    withheld.reasoningEfforts = 'entries disagree on whether this model reasons'
  } else if (reasons === 0 && nonReasoning > 0) {
    safe.reasoningEfforts = false
  }

  return {
    status: 'resolved',
    identity,
    entries: aggregate.entries,
    safe,
    withheld,
  }
}

/** Whether a cached index is still fresh enough to reuse. */
export function isFresh(index, now, ttlMs) {
  if (index === null || typeof index !== 'object') return false
  if (index.version !== CACHE_VERSION) return false
  const fetchedAt = index.fetchedAt
  return typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs
}

/** Join the harness home with this module's cache file. */
export function cachePaths(homePath) {
  const directory = join(homePath, 'cache', 'model-capability-detector')
  return { directory, file: join(directory, 'catalog.json') }
}

/**
 * Read the cached index.
 * @returns the parsed index, or `undefined` when absent or unreadable.
 */
export async function readCache(homePath) {
  const { file } = cachePaths(homePath)
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed === null || typeof parsed !== 'object' ? undefined : parsed
  } catch {
    return undefined
  }
}

/**
 * Persist the index for the next run. A failure is not fatal: the worst outcome
 * is re-fetching the catalog.
 * @returns whether the write succeeded.
 */
export async function writeCache(homePath, index) {
  const { directory, file } = cachePaths(homePath)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(file, JSON.stringify(index), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Download and index the public catalog.
 * @param options - URL, timeout, size ceiling, and cancellation.
 * @returns the index, or a failure description.
 */
export async function fetchCatalog(options) {
  const { url, timeoutMs, maxBytes, signal } = options
  const controller = new AbortController()
  const relay = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`catalog download timed out after ${timeoutMs} ms`)),
    timeoutMs,
  )
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: `${url} answered ${response.status}` }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: `${url} declares more than ${maxBytes} bytes` }
    }
    const text = await response.text()
    if (text.length > maxBytes) {
      return { ok: false, reason: `${url} answered with more than ${maxBytes} bytes` }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, reason: `${url} did not answer with JSON` }
    }
    const index = buildIndex(parsed)
    if (index === undefined) return { ok: false, reason: 'the catalog contained no usable models' }
    return { ok: true, index }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `could not read ${url}: ${message}` }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', relay)
  }
}

/**
 * Load the index, preferring a fresh cache and refreshing on staleness.
 *
 * A stale cache is better than no answer when the network is unavailable, so a
 * failed refresh falls back to whatever was cached.
 * @param options - home path, catalog URL, TTL, and limits.
 * @returns the index and how it was obtained, or the failure.
 */
export async function loadCatalog(options) {
  const { homePath, url, ttlMs, timeoutMs, maxBytes, signal, now = Date.now() } = options
  const cached = await readCache(homePath)
  if (isFresh(cached, now, ttlMs)) {
    return { ok: true, index: cached, source: 'cache' }
  }
  const fetched = await fetchCatalog({ url, timeoutMs, maxBytes, signal })
  if (fetched.ok) {
    const index = { ...fetched.index, fetchedAt: now }
    await writeCache(homePath, index)
    return { ok: true, index, source: 'network' }
  }
  if (cached !== undefined && cached.version === CACHE_VERSION) {
    return {
      ok: true,
      index: cached,
      source: 'stale-cache',
      warning: fetched.reason,
    }
  }
  return { ok: false, reason: fetched.reason }
}

/** Default cache lifetime: a week, matching how often catalogs change. */
export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
