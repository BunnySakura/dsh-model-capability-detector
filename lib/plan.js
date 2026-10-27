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

/** Fields this plugin fills, in the order it reports them. */
export const FIELDS = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']

/**
 * Fields a public catalog may supply by default.
 *
 * Measured across catalog entries that share a model name, input modalities
 * agree 87% of the time and reasoning levels 79%, while the context window
 * agrees only 52% and the output cap 47%. A wrong context window silently
 * truncates conversations, so those two need an explicit opt-in; a wrong
 * modality list only disables an attachment the user can still send as text.
 */
export const SAFE_CATALOG_FIELDS = ['input', 'reasoningEfforts']

/** Fields a catalog may supply only when the caller opts in. */
export const RISKY_CATALOG_FIELDS = ['contextWindow', 'maxTokens']

/**
 * Merge capabilities into the configured model rows.
 *
 * Endpoint data always wins; the catalog only fills fields the endpoint left
 * empty, and only fields the caller allows.
 * @param providers - the current `providers` value from the settings snapshot.
 * @param detected - endpoint capabilities per route, keyed by model id.
 * @param overwrite - replace already-configured values instead of filling blanks.
 * @param options - optional fallback source and its permitted fields.
 * @param options.resolve - maps a model id to a catalog resolution, or `undefined`.
 * @param options.allowedFields - which fields `resolve` may contribute.
 * @returns the next `providers` value, the changes, and which changes used the catalog.
 */
export function mergeDetected(providers, detected, overwrite, options = {}) {
  const resolve = typeof options.resolve === 'function' ? options.resolve : () => undefined
  const allowed = new Set(Array.isArray(options.allowedFields) ? options.allowedFields : [])
  const next = {}
  const changes = []
  const fallbacks = []

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
          const endpointValue = fromEndpoint?.[field]
          const catalogValue = allowed.has(field) ? catalogSafe?.[field] : undefined
          const value = endpointValue ?? catalogValue
          if (value === undefined) continue
          if (overwrite !== true && configured(model[field])) continue
          merged[field] = value
          filled.push(`${field}=${JSON.stringify(value)}`)
          if (endpointValue === undefined) viaCatalog.push(field)
        }
        if (filled.length > 0) {
          changes.push({ route, model: id, fields: filled })
          if (viaCatalog.length > 0) fallbacks.push({ route, model: id, fields: viaCatalog })
        }
        return merged
      }),
    }
  }

  return { providers: next, changes, fallbacks }
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
