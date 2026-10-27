/**
 * Tests for the public-catalog fallback.
 *
 * Run: node --test test/catalog.test.mjs
 * The fixtures are hand-built to cover the three decisions that matter: name
 * normalization, cross-entry agreement, and refusing to answer when entries
 * contradict each other.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CACHE_VERSION,
  buildIndex,
  isFresh,
  matchKey,
  resolveName,
  toLookup,
} from '../lib/catalog.js'

/** Build a catalog document shaped like models.dev's. */
function catalog(providers) {
  const document = {}
  for (const [providerId, models] of Object.entries(providers)) {
    document[providerId] = {
      id: providerId,
      name: providerId,
      models: Object.fromEntries(models.map((model) => [model.id, model])),
    }
  }
  return document
}

/** Index one catalog document and resolve one name against it. */
function resolveWith(document, name) {
  const index = buildIndex(document)
  assert.ok(index, 'the catalog produced an index')
  return resolveName(toLookup(index), name)
}

test('matchKey drops the provider prefix and every separator', () => {
  assert.equal(matchKey('gpt-6.1-sol'), 'gpt61sol')
  assert.equal(matchKey('GPT-6.1-SOL'), 'gpt61sol')
  assert.equal(matchKey('gpt_6_1_sol'), 'gpt61sol')
  assert.equal(matchKey('gpt 6.1 sol'), 'gpt61sol')
  assert.equal(matchKey('openai/gpt-6.1-sol'), 'gpt61sol')
  assert.equal(matchKey('anthropic/claude-sonnet-4-5'), 'claudesonnet45')
  assert.equal(matchKey(''), '')
  assert.equal(matchKey(undefined), '')
})

test('a name no entry carries resolves to unknown, never a guess', () => {
  const document = catalog({
    openai: [{ id: 'gpt-6.1-sol', limit: { context: 1000 } }],
  })
  for (const name of ['totally-made-up-model', 'gpt-9-ultra', 'gpt-6.2-sol']) {
    const answer = resolveWith(document, name)
    assert.equal(answer.status, 'unknown', name)
    assert.match(answer.reason, /no catalog entry matches/)
  }
})

test('agreed values are returned for every capability', () => {
  const document = catalog({
    openai: [
      {
        id: 'gpt-6.1-sol',
        canonical_model_id: 'openai/gpt-6.1-sol',
        limit: { context: 1050000, output: 128000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      },
    ],
    reseller: [
      {
        id: 'gpt-6.1-sol',
        canonical_model_id: 'openai/gpt-6.1-sol',
        limit: { context: 1050000, output: 128000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      },
    ],
  })
  const answer = resolveWith(document, 'GPT-6.1-SOL')
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.identity, 'gpt61sol')
  assert.equal(answer.entries, 2)
  assert.deepEqual(answer.safe, {
    contextWindow: 1050000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
  })
  assert.deepEqual(answer.withheld, {})
})

test('a contradicted context window is withheld with its candidates', () => {
  const document = catalog({
    openai: [
      {
        id: 'gpt-6.1-sol',
        limit: { context: 1050000, output: 128000 },
        modalities: { input: ['text', 'image'] },
      },
    ],
    reseller: [
      {
        id: 'gpt-6.1-sol',
        limit: { context: 922000, output: 128000 },
        modalities: { input: ['text', 'image'] },
      },
    ],
  })
  const answer = resolveWith(document, 'gpt-6.1-sol')
  assert.equal(answer.status, 'resolved')
  // Agreed fields survive; only the contradicted one is withheld.
  assert.equal(answer.safe.maxTokens, 128000)
  assert.deepEqual(answer.safe.input, ['text', 'image'])
  assert.equal(answer.safe.contextWindow, undefined)
  assert.deepEqual(answer.withheld.contextWindow, [922000, 1050000])
})

test('a name shared by two identities is ambiguous, not resolved to the first', () => {
  // A dated canonical and an undated one are genuinely different identities:
  // the catalog knows both, so the bare gateway name cannot pick between them.
  const document = catalog({
    'vendor-a': [
      {
        id: 'claude-sonnet-4-5',
        canonical_model_id: 'vendor-a/claude-sonnet-4-5',
        limit: { context: 200000 },
      },
    ],
    'vendor-b': [
      {
        id: 'claude-sonnet-4-5',
        canonical_model_id: 'vendor-b/claude-sonnet-4-5-20250929',
        limit: { context: 1000000 },
      },
    ],
  })
  const answer = resolveWith(document, 'claude-sonnet-4-5')
  assert.equal(answer.status, 'ambiguous')
  assert.match(answer.reason, /identities share this name/)
  assert.equal(answer.safe, undefined)
})

test('a provider prefix alone does not split one model into two identities', () => {
  // Both entries name the same model; only the catalog's redundant prefix differs.
  const document = catalog({
    'vendor-a': [{ id: 'gpt-6.1-sol', canonical_model_id: 'vendor-a/gpt-6.1-sol', limit: { context: 1000 } }],
    'vendor-b': [{ id: 'gpt-6.1-sol', canonical_model_id: 'vendor-b/gpt-6.1-sol', limit: { context: 1000 } }],
  })
  const answer = resolveWith(document, 'gpt-6.1-sol')
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.entries, 2)
  assert.equal(answer.safe.contextWindow, 1000)
})

test('a non-reasoning model reports false rather than silence', () => {
  const document = catalog({
    openai: [{ id: 'gpt-image-2', reasoning: false, limit: { output: 16384 } }],
  })
  const answer = resolveWith(document, 'gpt-image-2')
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.safe.reasoningEfforts, false)
  assert.equal(answer.safe.maxTokens, 16384)
  assert.equal(answer.safe.input, undefined, 'no modality list means no claim')
})

test('entries that disagree on reasoning are withheld', () => {
  const document = catalog({
    openai: [
      { id: 'mystery', reasoning: false },
    ],
    reseller: [
      {
        id: 'mystery',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    ],
  })
  const answer = resolveWith(document, 'mystery')
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.safe.reasoningEfforts, undefined)
  assert.match(String(answer.withheld.reasoningEfforts), /disagree/)
})

test('vendor level spellings normalize into pi-ai levels', () => {
  const document = catalog({
    gateway: [
      {
        id: 'thinking-model',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'mid', 'ultra'] }],
      },
    ],
  })
  const answer = resolveWith(document, 'thinking-model')
  assert.deepEqual(answer.safe.reasoningEfforts, {
    off: null,
    low: 'low',
    medium: 'medium',
    max: 'max',
  })
})

test('an empty or malformed catalog yields no index', () => {
  assert.equal(buildIndex({}), undefined)
  assert.equal(buildIndex(null), undefined)
  assert.equal(buildIndex([]), undefined)
  assert.equal(buildIndex({ a: { models: null } }), undefined)
  assert.equal(buildIndex({ a: { models: [] } }), undefined)
})

test('the index round-trips through JSON unchanged', () => {
  const document = catalog({
    openai: [{ id: 'gpt-6.1-sol', limit: { context: 1000 }, modalities: { input: ['text'] } }],
    reseller: [{ id: 'gpt-6.1-sol', limit: { context: 2000 }, modalities: { input: [] } }],
  })
  const index = buildIndex(document)
  const restored = JSON.parse(JSON.stringify(index))
  assert.deepEqual(restored, index)
  // And the restored form resolves identically.
  assert.deepEqual(resolveName(toLookup(restored), 'gpt-6.1-sol'), resolveName(toLookup(index), 'gpt-6.1-sol'))
})

test('isFresh honours the version and the TTL', () => {
  const now = 1_700_000_000_000
  assert.equal(isFresh({ version: CACHE_VERSION, fetchedAt: now - 10 }, now, 1000), true)
  assert.equal(isFresh({ version: CACHE_VERSION, fetchedAt: now - 2000 }, now, 1000), false)
  // A version bump invalidates a cache built by the previous format.
  assert.equal(isFresh({ version: CACHE_VERSION + 1, fetchedAt: now }, now, 1000), false)
  assert.equal(isFresh({ version: CACHE_VERSION }, now, 1000), false)
  assert.equal(isFresh(undefined, now, 1000), false)
})

test('catalog numbers never become booleans or strings', () => {
  const document = catalog({
    gateway: [
      {
        id: 'weird',
        limit: { context: '1000000', output: 0 },
      },
    ],
  })
  const answer = resolveWith(document, 'weird')
  assert.equal(answer.status, 'resolved')
  // A numeric string is accepted; a zero is not a usable capacity.
  assert.equal(answer.safe.contextWindow, 1000000)
  assert.equal(answer.safe.maxTokens, undefined)
})
