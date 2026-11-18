/**
 * Model identity normalization shared by public-source lookups.
 * Provider prefixes and cosmetic separators can differ across gateways, but
 * dates and :variants can change capabilities and must remain part of the key.
 */

/** Lower-case id without its provider prefix; preserve any :variant suffix. */
export function leafOf(id) {
  const text = String(id ?? '').trim().toLowerCase()
  return text.slice(text.lastIndexOf('/') + 1)
}

export function nameKeys(id) {
  // Keep ':' as a boundary so model:free cannot collide with model-free.
  const compact = leafOf(id).split(':').map((part) => part.replace(/[^a-z0-9]/g, '')).join(':')
  // Retain the serialized family field for compatibility with lookup consumers.
  // Snapshot-line inference is exclusively handled by resolveSibling.
  return { compact, family: compact }
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
