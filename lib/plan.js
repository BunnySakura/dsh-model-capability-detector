/**
 * Turn detected capabilities into the next `providers` value.
 *
 * The write goes through `settings.update`, which merges the value into the
 * profile patch, so this module must return a complete `providers` object
 * rather than a patch: an array path handed to `settings.mutate` would
 * materialize as an object when the row it addresses lives in an inherited
 * layer, and a model entry rebuilt from partial paths loses its `id`.
 *
 * @module dsh-model-capability-detector/plan
 */

import { configured } from './detect.js'
import { SOURCE_RANK, rankOf } from './tiers.js'

/** Fields this plugin fills, in the order it reports them. */
export const FIELDS = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']

/** Non-numeric catalog fields, subject to agreement/intersection rules. */
export const SAFE_CATALOG_FIELDS = ['input', 'reasoningEfforts']

/** Numeric catalog fields controlled by catalogNumbers and its decision rule. */
export const RISKY_CATALOG_FIELDS = ['contextWindow', 'maxTokens']

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/** A receipt below this rank may be replaced when a better source appears. */
export const UPGRADE_BELOW_RANK = SOURCE_RANK['official-verified']

/**
 * Merge capabilities into the configured model rows.
 *
 * Per field the highest-ranked source wins: the channel's unambiguous API
 * fields, then original-provider records, third-party consensus, API hints.
 * A value already present is kept unless `overwrite` is set, or `upgrade` is
 * on and the plugin itself wrote it from a lower-ranked source (proved by a
 * receipt whose value still equals the current one). Hand-typed values have no
 * matching receipt and are never changed.
 * @param providers - the current `providers` value from the settings snapshot.
 * @param detected - endpoint capabilities per route, keyed by model id.
 * @param overwrite - replace already-configured values instead of filling blanks.
 * @param options.resolve - maps a model id to a catalog resolution, or `undefined`.
 * @param options.allowedFields - which fields `resolve` may contribute.
 * @param options.receiptFor - `(route, model, field) => receipt | undefined`.
 * @param options.upgrade - allow replacing plugin-written lower-tier values.
 * @returns the next `providers`, the changes, catalog-sourced fields, receipts to
 *   record and the upgrades performed.
 */
export function mergeDetected(providers, detected, overwrite, options = {}) {
  const resolve = typeof options.resolve === 'function' ? options.resolve : () => undefined
  const allowed = new Set(Array.isArray(options.allowedFields) ? options.allowedFields : [])
  const receiptFor = typeof options.receiptFor === 'function' ? options.receiptFor : () => undefined
  const upgrade = options.upgrade === true
  const next = {}
  const changes = []
  const fallbacks = []
  const provenance = []
  const upgrades = []

  for (const [route, profile] of Object.entries(providers ?? {})) {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      next[route] = profile
      continue
    }
    if (!Array.isArray(profile.models)) {
      next[route] = profile
      continue
    }
    const found = detected.get(route)
    next[route] = {
      ...profile,
      models: profile.models.map((model) => {
        if (model === null || typeof model !== 'object' || Array.isArray(model)) return model
        const id = typeof model.id === 'string' ? model.id : undefined
        const fromEndpoint = id === undefined ? undefined : found?.get(id)
        const fromCatalog = id === undefined ? undefined : resolve(id)
        const catalogSafe = fromCatalog?.safe
        const hasCatalog =
          allowed.size > 0 &&
          catalogSafe !== undefined &&
          Object.keys(catalogSafe).length > 0
        if (fromEndpoint === undefined && !hasCatalog) return model

        const merged = { ...model }
        const filled = []
        const viaCatalog = []
        for (const field of FIELDS) {
          const candidates = []
          const endpointValue = fromEndpoint?.[field]
          if (endpointValue !== undefined) candidates.push({ value: endpointValue, via: 'endpoint', source: { kind: 'channel-api', channelVerified: true } })
          const catalogValue = allowed.has(field) ? catalogSafe?.[field] : undefined
          if (catalogValue !== undefined) {
            candidates.push({ value: catalogValue, via: 'catalog', source: fromCatalog?.sources?.[field] ?? { kind: 'legacy-catalog', channelVerified: false } })
          }
          const hintValue = fromEndpoint?.hints?.[field]
          if (hintValue !== undefined) candidates.push({ value: hintValue, via: 'hint', source: { kind: 'api-hint', channelVerified: false } })
          if (candidates.length === 0) continue
          const best = candidates.reduce((top, item) => (rankOf(item.source) > rankOf(top.source) ? item : top))

          let upgradedFrom
          if (overwrite !== true && configured(model[field])) {
            const receipt = upgrade && id !== undefined ? receiptFor(route, id, field) : undefined
            if (receipt === undefined || !sameValue(receipt.value, model[field]) || rankOf(receipt.source) >= rankOf(best.source)) continue
            upgradedFrom = receipt.source?.kind ?? 'unknown'
          }
          provenance.push({ route, model: id, field, value: best.value, source: best.source })
          if (upgradedFrom !== undefined) {
            upgrades.push({ route, model: id, field, from: upgradedFrom, to: best.source.kind })
            // Same value, better evidence: only the receipt changes.
            if (sameValue(model[field], best.value)) continue
          }
          merged[field] = best.value
          filled.push(`${field}=${JSON.stringify(best.value)}${upgradedFrom === undefined ? '' : ` (upgraded from ${upgradedFrom})`}`)
          if (best.via !== 'endpoint') viaCatalog.push(field)
        }
        if (filled.length > 0) {
          changes.push({ route, model: id, fields: filled })
          if (viaCatalog.length > 0) fallbacks.push({ route, model: id, fields: viaCatalog })
        }
        return merged
      }),
    }
  }

  return { providers: next, changes, fallbacks, provenance, upgrades }
}

/**
 * Whether the plugin wrote a field from a source that a better one could replace.
 * @param receiptFor - `(route, model, field) => receipt | undefined`.
 */
export function hasUpgradable(providers, receiptFor) {
  for (const [route, profile] of Object.entries(providers ?? {})) {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile) || !Array.isArray(profile.models)) continue
    for (const model of profile.models) {
      if (model === null || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string') continue
      for (const field of FIELDS) {
        if (!configured(model[field])) continue
        const receipt = receiptFor(route, model.id, field)
        if (receipt !== undefined && sameValue(receipt.value, model[field]) && rankOf(receipt.source) < UPGRADE_BELOW_RANK) return true
      }
    }
  }
  return false
}
/** Whether two `providers` values serialize identically. */
export function sameProviders(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** One-line-per-change report for the log. */
export function describeChanges(changes) {
  return changes.map((change) => `${change.route}/${change.model}: ${change.fields.join(', ')}`)
}

/** One-line-per-fallback report, naming which fields came from the catalog. */
export function describeFallbacks(fallbacks) {
  return fallbacks.map(
    (entry) => `${entry.route}/${entry.model}: ${entry.fields.join(', ')} (from catalog)`,
  )
}

/**
 * Whether any configured model still has a field worth filling.
 *
 * This runs before any network call, so a settings change on a profile whose
 * models are fully described costs nothing. With `overwrite` the pass always
 * runs, because a source may disagree with a value the user typed.
 * @param providers - the profile's own `providers` value.
 * @param overwrite - whether configured values may be replaced.
 * @returns whether detection could change anything.
 */
export function hasBlanks(providers, overwrite) {
  if (overwrite === true) return true
  for (const profile of Object.values(providers ?? {})) {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) continue
    if (!Array.isArray(profile.models)) continue
    for (const model of profile.models) {
      if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
      if (typeof model.id !== 'string' || model.id.length === 0) continue
      if (FIELDS.some((field) => !configured(model[field]))) return true
    }
  }
  return false
}
