/**
 * Public catalog fallback, matched by normalized model identity.
 * Numeric capacities default to the smallest disclosed valid value; callers can
 * require consensus instead. Reasoning levels use the intersection of disclosed
 * sets, and a name reaching multiple identities never resolves to a guess.
 *
 * @module dsh-model-capability-detector/catalog
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { effortsFromLevels, normalizeLevel, positiveInteger } from './detect.js'
import { readJsonResponse } from './http.js'

/** Cache format version; bump when the aggregate shape changes. */
export const CACHE_VERSION = 3

/** Normalize a model name, dropping its provider prefix and separators. */
export function matchKey(name) {
  const text = String(name ?? '')
  const bare = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Accumulate one catalog identity's disclosed capabilities. */
function emptyAggregate() {
  return {
    contexts: new Set(),
    outputs: new Set(),
    images: new Set(),
    levels: null,
    levelDisclosures: 0,
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

  const levels = new Set()
  for (const option of Array.isArray(model?.reasoning_options) ? model.reasoning_options : []) {
    if (option?.type !== 'effort') continue
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const level = normalizeLevel(value)
      if (level !== undefined) levels.add(level)
    }
  }
  if (levels.size > 0) {
    aggregate.levelDisclosures += 1
    aggregate.levels = aggregate.levels === null
      ? levels
      : new Set([...aggregate.levels].filter((level) => levels.has(level)))
  }

  // Classify this entry alone. Earlier entries' levels must not turn a later
  // non-reasoning or undisclosed entry into a reasoning disclosure.
  const hasReasoningLevel = [...levels].some((level) => level !== 'off')
  if (hasReasoningLevel || model?.reasoning === true) aggregate.reasoning += 1
  if (model?.reasoning === false || (levels.size === 1 && levels.has('off'))) {
    aggregate.nonReasoning += 1
  }
}

/**
 * Build serializable identity aggregates and the names that reach them.
 * @returns the index, or `undefined` when nothing usable was found.
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
        levels: [...(aggregate.levels ?? [])].sort(),
        levelDisclosures: aggregate.levelDisclosures,
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
function settle(values) {
  if (!Array.isArray(values) || values.length === 0) return { state: 'absent' }
  if (values.length === 1) return { state: 'agreed', value: values[0] }
  return { state: 'conflict', candidates: values }
}

/**
 * Resolve one model name from the catalog index.
 *
 * `safe` holds usable fields and `withheld` only fields actually rejected.
 * `numericDecisions` explains the numeric strategy, candidates, selected value
 * (when accepted), and whether the minimum estimates a conflicting capacity.
 * Missing disclosures make no claim and do not veto other entries.
 * @param lookup - the rehydrated index.
 * @param requested - the model id as the provider advertised it.
 * @param options - `numericStrategy`: 'minimum' (default) or 'consensus'.
 */
export function resolveName(lookup, requested, options = {}) {
  const { numericStrategy = 'minimum' } = options
  if (numericStrategy !== 'minimum' && numericStrategy !== 'consensus') {
    throw new RangeError('numericStrategy must be minimum or consensus')
  }
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
  const numericDecisions = {}
  for (const [field, values] of [
    ['contextWindow', aggregate.contexts],
    ['maxTokens', aggregate.outputs],
  ]) {
    const candidates = [...new Set((Array.isArray(values) ? values : [])
      .map((value) => positiveInteger(value))
      .filter((value) => value !== undefined))].sort((a, b) => a - b)
    if (candidates.length === 0) continue
    const decision = { strategy: numericStrategy, candidates, estimated: false }
    if (numericStrategy === 'minimum' || candidates.length === 1) {
      safe[field] = candidates[0]
      decision.value = candidates[0]
      decision.estimated = candidates.length > 1
    } else withheld[field] = candidates
    numericDecisions[field] = decision
  }

  const image = settle(aggregate.images)
  if (image.state === 'agreed') safe.input = image.value ? ['text', 'image'] : ['text']
  else if (image.state === 'conflict') withheld.input = image.candidates

  const levels = Array.isArray(aggregate.levels) ? aggregate.levels : []
  const reasons = aggregate.reasoning ?? 0
  const nonReasoning = aggregate.nonReasoning ?? 0
  if (reasons > 0 && nonReasoning > 0) {
    withheld.reasoningEfforts = 'entries disagree on whether this model reasons'
  } else if (levels.length > 0) {
    if (levels.every((level) => level === 'off')) safe.reasoningEfforts = false
    else {
      const efforts = effortsFromLevels(new Set(levels))
      if (efforts !== undefined) safe.reasoningEfforts = efforts
    }
  } else if ((aggregate.levelDisclosures ?? 0) > 0) {
    withheld.reasoningEfforts = 'disclosed reasoning level sets have no common level'
  } else if (nonReasoning > 0) {
    safe.reasoningEfforts = false
  }

  return {
    status: 'resolved',
    identity,
    entries: aggregate.entries,
    safe,
    withheld,
    numericDecisions,
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

/** Read the cached index, or `undefined` when absent or unreadable. */
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

/** Persist the index for the next run; a failed write is nonfatal. */
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

/** Download and index the public catalog with bounded response reads. */
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
    if (!response.ok) return { ok: false, reason: `catalog answered ${response.status}` }
    const parsed = await readJsonResponse(response, maxBytes)
    const index = buildIndex(parsed)
    if (index === undefined) return { ok: false, reason: 'the catalog contained no usable models' }
    return { ok: true, index }
  } catch (error) {
    // Network exceptions and abort reasons may embed credentials from the URL.
    const message = error instanceof Error ? error.message : ''
    const safeMessage = /^response (?:declares more than \d+ bytes|exceeds \d+ bytes|has no body|did not answer with JSON)$/.test(message)
      ? message
      : controller.signal.aborted ? 'catalog download was aborted' : 'could not read catalog'
    return { ok: false, reason: safeMessage }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', relay)
  }
}

/**
 * Load a fresh cache or refresh it; a failed refresh can use a stale cache only
 * from the same source and format. Hashing the URL avoids persisting query secrets.
 */
export async function loadCatalog(options) {
  const { homePath, url, ttlMs, timeoutMs, maxBytes, signal, now = Date.now() } = options
  const sourceKey = createHash('sha256').update(url).digest('hex')
  const cached = await readCache(homePath)
  const sameSource = cached?.sourceKey === sourceKey
  if (sameSource && isFresh(cached, now, ttlMs)) {
    return { ok: true, index: cached, source: 'cache' }
  }
  const fetched = await fetchCatalog({ url, timeoutMs, maxBytes, signal })
  if (fetched.ok) {
    const index = { ...fetched.index, fetchedAt: now, sourceKey }
    await writeCache(homePath, index)
    return { ok: true, index, source: 'network' }
  }
  if (sameSource && cached.version === CACHE_VERSION) {
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
