/**
 * Model-name normalization shared by the original-provider and third-party
 * lookups. Gateways decorate names (`vendor/model:free`, dated snapshots,
 * `3.5` versus `3-5`); each level below relaxes the match one step further.
 *
 * - `compact`: provider prefix and `:variant` removed, punctuation folded.
 * - `family`: `compact` with a trailing 8-digit date snapshot removed.
 *
 * Short numeric suffixes such as `-1017` are part of a model's identity and
 * are never stripped.
 */
const DATE_SUFFIX = /[-_.]?20\d{2}[-_.]?\d{2}[-_.]?\d{2}$/

/** Lower-case id without provider prefix or `:variant` suffix. */
export function leafOf(id) {
  const text = String(id ?? '').trim().toLowerCase()
  const withoutVariant = text.replace(/:[a-z0-9._-]+$/, '')
  return withoutVariant.slice(withoutVariant.lastIndexOf('/') + 1)
}

export function nameKeys(id) {
  const leaf = leafOf(id)
  const fold = (text) => text.replace(/[^a-z0-9]/g, '')
  return { compact: fold(leaf), family: fold(leaf.replace(DATE_SUFFIX, '')) }
}

/**
 * Apply the user's alias table. Keys are matched case-insensitively and
 * exactly; an alias never chains into another alias.
 */
export function applyAlias(aliases, requested) {
  if (aliases === null || typeof aliases !== 'object' || typeof requested !== 'string') return requested
  const wanted = requested.trim().toLowerCase()
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof to === 'string' && from.trim().toLowerCase() === wanted) return to
  }
  return requested
}
