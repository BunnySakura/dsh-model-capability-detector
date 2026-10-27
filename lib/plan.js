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
 * Merge discovered capabilities into the configured model rows.
 * @param providers - the current `providers` value from the settings snapshot.
 * @param detected - capabilities per route, keyed by model id.
 * @param overwrite - replace already-configured values instead of filling blanks.
 * @returns the next `providers` value and the field changes it applies.
 */
export function mergeDetected(providers, detected, overwrite) {
  const next = {}
  const changes = []
  for (const [route, profile] of Object.entries(providers ?? {})) {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      next[route] = profile
      continue
    }
    const found = detected.get(route)
    if (found === undefined || !Array.isArray(profile.models)) {
      next[route] = profile
      continue
    }
    next[route] = {
      ...profile,
      models: profile.models.map((model) => {
        if (model === null || typeof model !== 'object' || Array.isArray(model)) return model
        const id = typeof model.id === 'string' ? model.id : undefined
        const capabilities = id === undefined ? undefined : found.get(id)
        if (capabilities === undefined) return model
        const merged = { ...model }
        const filled = []
        for (const field of FIELDS) {
          const value = capabilities[field]
          if (value === undefined) continue
          if (overwrite !== true && configured(model[field])) continue
          merged[field] = value
          filled.push(`${field}=${JSON.stringify(value)}`)
        }
        if (filled.length > 0) changes.push({ route, model: id, fields: filled })
        return merged
      }),
    }
  }
  return { providers: next, changes }
}

/** Whether two `providers` values serialize identically. */
export function sameProviders(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** One-line-per-change report for the log. */
export function describeChanges(changes) {
  return changes.map((change) => `${change.route}/${change.model}: ${change.fields.join(', ')}`)
}
