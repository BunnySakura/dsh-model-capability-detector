/**
 * Source tiers for catalog-provided capabilities.
 *
 * Priority, highest first: the channel's own unambiguous API fields (handled in
 * `plan.js`), original-provider records, third-party consensus, then API hints.
 * A third-party value is used only when at least two independent sources
 * (OpenRouter, LiteLLM, models.dev) agree and none disagrees. Reasoning levels
 * come from original records only, because the third-party tables carry no
 * level names.
 */
import { matchKey } from './catalog.js'
import { applyAlias } from './names.js'
import { resolveOfficial, resolveSibling } from './official.js'
import { pickAgreed, voteFor } from './sources.js'

/** Higher wins. Receipts store only the kind, so rank is derived from it. */
export const SOURCE_RANK = {
  'channel-api': 6,
  'official-verified': 5,
  'original-provider-mirror': 4,
  'official-sibling': 3,
  'third-party-consensus': 2,
  'api-hint': 1,
  'legacy-catalog': 0,
}
export const rankOf = (source) => SOURCE_RANK[source?.kind] ?? -1

const FIELD_VOTE = { contextWindow: 'context', maxTokens: 'output', input: 'image' }

/** models.dev as one voter: all its publishers must agree on a value. */
function modelsDevVote(lookup, requested) {
  const identities = lookup?.reach?.get(matchKey(requested))
  if (identities === undefined || identities.length !== 1) return undefined
  const group = lookup.groups.get(identities[0])
  if (group === undefined) return undefined
  const one = (values) => (!Array.isArray(values) || values.length === 0 ? undefined : pickAgreed(values.map((value) => ({ value })))?.value ?? 'conflict')
  return { match: 'compact', context: one(group.contexts), output: one(group.outputs), image: one(group.images) }
}

/**
 * Tally the voters for one field. A source whose own rows split evenly
 * abstains rather than vetoing the others; at least two sources must remain,
 * and the largest agreeing group (numbers within tolerance) must be strictly
 * larger than any other.
 * @returns `{ value, sources, family }` when accepted, otherwise `{ reason }`.
 */
function decide(votes, key) {
  const all = Object.entries(votes).filter(([, vote]) => vote?.[key] !== undefined)
  if (all.length === 0) return { reason: 'no-third-party-data' }
  const cast = all.filter(([, vote]) => vote[key] !== 'conflict')
  if (cast.length === 0) return { reason: 'third-party-conflict' }
  if (cast.length < 2) return { reason: 'single-third-party-source' }
  const picked = pickAgreed(cast.map(([name, vote]) => ({ value: vote[key], name, family: vote.match === 'family' })))
  if (picked === undefined) return { reason: 'third-party-conflict' }
  return { value: picked.value, sources: picked.members.map((member) => member.name), family: picked.members.some((member) => member.family) }
}
/**
 * Resolve a requested model name through every catalog tier.
 * @param lookup models.dev lookup (`toLookup`).
 * @param thirdParty `{ openrouter, litellm }` source lookups, or undefined.
 * @param options `{ aliases }`.
 * @returns the same shape as `resolveOfficial`, extended with `reasons`
 *   (why a field is empty) and `votes`.
 */
export function resolveTiered(lookup, thirdParty, requested, options = {}) {
  const name = applyAlias(options.aliases, requested)
  const base = resolveOfficial(lookup.officialRecords, name)
  const aliased = name !== requested
  if (base.status === 'ambiguous') return { ...base, aliased, reasons: {} }
  const result = base.status === 'resolved'
    ? { ...base, aliased, reasons: {} }
    : { status: 'unknown', reason: base.reason, safe: {}, withheld: {}, sources: {}, numericDecisions: {}, aliased, reasons: {} }
  for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
    if (result.safe[field] === undefined && result.withheld[field] === undefined) {
      result.reasons[field] = base.status === 'resolved' ? 'not-disclosed-by-original' : 'no-original-record'
    } else if (result.withheld[field] !== undefined) result.reasons[field] = 'original-records-disagree'
  }
  // A name without a snapshot tag inherits what the dated snapshots of its line
  // agree on. Only reasoning is shared this way; numeric limits stay per snapshot.
  if (result.safe.reasoningEfforts === undefined && result.withheld.reasoningEfforts === undefined) {
    const inherited = resolveSibling(lookup.officialRecords, name)
    if (inherited !== undefined) {
      result.safe.reasoningEfforts = inherited.value
      result.sources.reasoningEfforts = inherited.source
      delete result.reasons.reasoningEfforts
      if (result.status === 'unknown') result.status = 'resolved'
    }
  }
  const votes = {
    ...(thirdParty?.openrouter === undefined ? {} : { openrouter: voteFor(thirdParty.openrouter, name) }),
    ...(thirdParty?.litellm === undefined ? {} : { litellm: voteFor(thirdParty.litellm, name) }),
    models_dev: modelsDevVote(lookup, name),
  }
  result.votes = Object.fromEntries(Object.entries(votes).filter(([, vote]) => vote !== undefined))
  for (const [field, key] of Object.entries(FIELD_VOTE)) {
    // An original record, or a disagreement among original records, is final.
    if (result.safe[field] !== undefined || result.withheld[field] !== undefined) continue
    const decision = decide(result.votes, key)
    if (decision.reason !== undefined) { result.reasons[field] = decision.reason; continue }
    const value = field === 'input' ? (decision.value ? ['text', 'image'] : ['text']) : decision.value
    result.safe[field] = value
    result.sources[field] = { kind: 'third-party-consensus', sources: decision.sources, match: decision.family ? 'family' : 'compact', channelVerified: false }
    delete result.reasons[field]
    if (field !== 'input') result.numericDecisions[field] = { strategy: 'third-party-consensus', value, estimated: false }
  }
  if (result.status === 'unknown' && Object.keys(result.safe).length > 0) result.status = 'resolved'
  return result
}
