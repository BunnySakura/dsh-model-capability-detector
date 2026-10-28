/**
 * Tests for the public-catalog fallback.
 *
 * Run: node --test test/catalog.test.mjs
 * Hand-built fixtures cover identity matching, numeric strategies, reasoning
 * intersections, source-isolated caches, and bounded offline HTTP reads.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'

import {
  CACHE_VERSION,
  buildIndex,
  fetchCatalog,
  isFresh,
  loadCatalog,
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
function resolveWith(document, name, options) {
  const index = buildIndex(document)
  assert.ok(index, 'the catalog produced an index')
  return resolveName(toLookup(index), name, options)
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

test('conflicting numeric capacities default to the minimum and consensus can withhold', () => {
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
  assert.equal(answer.safe.maxTokens, 128000)
  assert.deepEqual(answer.safe.input, ['text', 'image'])
  assert.equal(answer.safe.contextWindow, 922000)
  assert.deepEqual(answer.withheld, {})
  assert.deepEqual(answer.numericDecisions.contextWindow, {
    strategy: 'minimum', candidates: [922000, 1050000], value: 922000, estimated: true,
  })
  assert.equal(answer.numericDecisions.maxTokens.estimated, false)

  const consensus = resolveWith(document, 'gpt-6.1-sol', { numericStrategy: 'consensus' })
  assert.equal(consensus.safe.contextWindow, undefined)
  assert.equal(consensus.safe.maxTokens, 128000)
  assert.deepEqual(consensus.withheld.contextWindow, [922000, 1050000])
  assert.deepEqual(consensus.numericDecisions.contextWindow, {
    strategy: 'consensus', candidates: [922000, 1050000], estimated: false,
  })
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

test('minimum ignores invalid capacities and handles both numeric fields', () => {
  const invalid = [0, -1, true, false, null, '', '1.5', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]
  const providers = Object.fromEntries(invalid.map((value, i) => [
    `invalid-${i}`, [{ id: 'capacity', limit: { context: value, output: value } }],
  ]))
  const answer = resolveWith(catalog({
    ...providers,
    a: [{ id: 'capacity', limit: { context: ' 1024 ', output: 512 } }],
    b: [{ id: 'capacity', limit: { context: 4096, output: '256' } }],
    c: [{ id: 'capacity' }],
  }), 'capacity')
  assert.deepEqual(answer.safe, { contextWindow: 1024, maxTokens: 256 })
  assert.deepEqual(answer.withheld, {})
  assert.deepEqual(answer.numericDecisions.maxTokens.candidates, [256, 512])
})

test('invalid cached numeric values cannot become minimum estimates', () => {
  const lookup = {
    reach: new Map([['capacity', ['capacity']]]),
    groups: new Map([['capacity', {
      contexts: [0, false, -2, Number.MAX_SAFE_INTEGER + 1, 400, '200', 400],
      outputs: [null, true, -1],
    }]]),
  }
  const answer = resolveName(lookup, 'capacity')
  assert.equal(answer.safe.contextWindow, 200)
  assert.equal(answer.safe.maxTokens, undefined)
  assert.deepEqual(answer.numericDecisions.contextWindow.candidates, [200, 400])
  assert.deepEqual(answer.withheld, {})
})

test('numeric strategy must name a supported decision rule', () => {
  const lookup = toLookup(buildIndex(catalog({ a: [{ id: 'model' }] })))
  assert.throws(() => resolveName(lookup, 'model', { numericStrategy: 'average' }), /numericStrategy/)
})

test('identity ambiguity is refused under both numeric strategies', () => {
  const document = catalog({
    a: [{ id: 'model', canonical_model_id: 'model-v1', limit: { context: 1000 } }],
    b: [{ id: 'model', canonical_model_id: 'model-v2', limit: { context: 2000 } }],
  })
  for (const numericStrategy of ['minimum', 'consensus']) {
    const answer = resolveWith(document, 'model', { numericStrategy })
    assert.equal(answer.status, 'ambiguous')
    assert.equal(answer.safe, undefined)
  }
})

test('reasoning levels intersect and undisclosed entries do not veto them', () => {
  const document = catalog({
    a: [{ id: 'thinking', reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] }],
    b: [{ id: 'thinking', reasoning_options: [{ type: 'effort', values: ['mid', 'high', 'max'] }] }],
    c: [{ id: 'thinking' }],
    d: [{ id: 'thinking', reasoning: true }],
    e: [{ id: 'thinking', reasoning_options: [{ type: 'effort', values: ['unknown'] }] }],
  })
  const index = buildIndex(document)
  const aggregate = toLookup(index).groups.get('thinking')
  assert.equal(aggregate.reasoning, 3, 'only this entry’s own disclosure counts')
  assert.equal(aggregate.levelDisclosures, 2)
  const answer = resolveName(toLookup(index), 'thinking')
  assert.deepEqual(answer.safe.reasoningEfforts, { medium: 'medium', high: 'high' })
  assert.deepEqual(answer.withheld, {})
})

test('disjoint disclosed reasoning sets are refused and remain empty after later entries', () => {
  const document = catalog({
    a: [{ id: 'thinking', reasoning_options: [{ type: 'effort', values: ['low'] }] }],
    b: [{ id: 'thinking', reasoning_options: [{ type: 'effort', values: ['high'] }] }],
    c: [{ id: 'thinking', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }],
  })
  const answer = resolveWith(document, 'thinking')
  assert.equal(answer.safe.reasoningEfforts, undefined)
  assert.match(answer.withheld.reasoningEfforts, /no common level/)
})

test('explicit reasoning disagreement is refused even without disclosed levels', () => {
  const answer = resolveWith(catalog({
    a: [{ id: 'model', reasoning: true }],
    b: [{ id: 'model', reasoning: false }],
  }), 'model')
  assert.equal(answer.safe.reasoningEfforts, undefined)
  assert.match(answer.withheld.reasoningEfforts, /disagree/)
})

test('a later non-reasoning entry is not counted as reasoning by earlier levels', () => {
  const index = buildIndex(catalog({
    a: [{ id: 'model', reasoning_options: [{ type: 'effort', values: ['low'] }] }],
    b: [{ id: 'model', reasoning: false }],
  }))
  const lookup = toLookup(index)
  assert.equal(lookup.groups.get('model').reasoning, 1)
  assert.equal(lookup.groups.get('model').nonReasoning, 1)
  assert.match(resolveName(lookup, 'model').withheld.reasoningEfforts, /disagree/)
})

test('off-only disclosures return false and conflict with explicit reasoning', () => {
  const off = { id: 'model', reasoning_options: [{ type: 'effort', values: ['none', 'disabled'] }] }
  const answer = resolveWith(catalog({ a: [off], b: [{ id: 'model' }] }), 'model')
  assert.equal(answer.safe.reasoningEfforts, false)
  assert.deepEqual(answer.withheld, {})
  const conflict = resolveWith(catalog({ a: [off], b: [{ id: 'model', reasoning: true }] }), 'model')
  assert.equal(conflict.safe.reasoningEfforts, undefined)
  assert.match(conflict.withheld.reasoningEfforts, /disagree/)
})

test('an intersection containing only off can disable reasoning', () => {
  const answer = resolveWith(catalog({
    a: [{ id: 'model', reasoning_options: [{ type: 'effort', values: ['off', 'low'] }] }],
    b: [{ id: 'model', reasoning_options: [{ type: 'effort', values: ['off', 'high'] }] }],
  }), 'model')
  assert.equal(answer.safe.reasoningEfforts, false)
})

test('non-reasoning and undisclosed entries remain order-independent', () => {
  for (const models of [[{ id: 'model' }, { id: 'model', reasoning: false }],
    [{ id: 'model', reasoning: false }, { id: 'model' }]]) {
    const answer = resolveWith(catalog({ a: [models[0]], b: [models[1]] }), 'model')
    assert.equal(answer.safe.reasoningEfforts, false)
  }
})

/** Mock both storage and fetch; cache tests never write, delete, or contact a host. */
async function withMemoryCache(t, run) {
  let stored
  const calls = []
  let response = () => new Response(JSON.stringify(catalog({ a: [{ id: 'model', limit: { context: 1000 } }] })))
  const mocks = [
    t.mock.method(fs, 'readFile', async () => {
      if (stored === undefined) throw new Error('cache absent')
      return stored
    }),
    t.mock.method(fs, 'mkdir', async () => undefined),
    t.mock.method(fs, 'writeFile', async (_path, text) => { stored = text }),
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, options })
      return response(url, options)
    }),
  ]
  syncBuiltinESMExports()
  try {
    await run({
      calls,
      cached: () => stored === undefined ? undefined : JSON.parse(stored),
      stored: () => stored,
      seed: (index) => { stored = JSON.stringify(index) },
      respond: (handler) => { response = handler },
    })
  } finally {
    for (const mocked of mocks) mocked.mock.restore()
    syncBuiltinESMExports()
  }
}

const loadOptions = {
  homePath: 'memory-cache',
  url: 'https://catalog.test/api.json?token=private-value',
  ttlMs: 1000,
  timeoutMs: 1000,
  maxBytes: 100000,
  now: 10000,
}
const sourceKey = (url) => createHash('sha256').update(url).digest('hex')

test('catalog cache persists only the source hash and reuses a fresh matching source', async (t) => {
  await withMemoryCache(t, async (memory) => {
    const first = await loadCatalog(loadOptions)
    assert.equal(first.source, 'network')
    assert.equal(first.index.sourceKey, sourceKey(loadOptions.url))
    assert.equal(memory.cached().sourceKey, sourceKey(loadOptions.url))
    assert.equal(memory.cached().sourceUrl, undefined)
    assert.equal(memory.stored().includes('private-value'), false)
    const next = await loadCatalog(loadOptions)
    assert.equal(next.source, 'cache')
    assert.equal(memory.calls.length, 1)
  })
})

test('a changed catalog source refreshes even a fresh cache', async (t) => {
  await withMemoryCache(t, async (memory) => {
    await loadCatalog(loadOptions)
    const url = 'https://other-catalog.test/api.json'
    const next = await loadCatalog({ ...loadOptions, url })
    assert.equal(next.source, 'network')
    assert.equal(next.index.sourceKey, sourceKey(url))
    assert.equal(memory.calls.length, 2)
  })
})

test('a failed source switch cannot fall back to another source’s cache', async (t) => {
  await withMemoryCache(t, async (memory) => {
    await loadCatalog(loadOptions)
    memory.respond(() => new Response('', { status: 503 }))
    for (const now of [loadOptions.now, loadOptions.now + 2000]) {
      const next = await loadCatalog({ ...loadOptions, url: 'https://other.test/catalog', now })
      assert.equal(next.ok, false)
      assert.match(next.reason, /503/)
    }
    assert.equal(memory.cached().sourceKey, sourceKey(loadOptions.url))
  })
})

test('an expired matching source can fall back after refresh failure', async (t) => {
  await withMemoryCache(t, async (memory) => {
    await loadCatalog(loadOptions)
    memory.respond(() => new Response('', { status: 503 }))
    const next = await loadCatalog({ ...loadOptions, now: loadOptions.now + 2000 })
    assert.equal(next.source, 'stale-cache')
    assert.match(next.warning, /503/)
  })
})

test('legacy and unidentified caches cannot serve as fresh or stale fallbacks', async (t) => {
  await withMemoryCache(t, async (memory) => {
    memory.respond(() => new Response('', { status: 503 }))
    for (const extra of [
      { version: CACHE_VERSION - 1, sourceKey: sourceKey(loadOptions.url) },
      { version: CACHE_VERSION },
      { version: CACHE_VERSION, sourceUrl: loadOptions.url },
    ]) {
      memory.seed({ ...buildIndex(catalog({ a: [{ id: 'model' }] })), fetchedAt: loadOptions.now, ...extra })
      const next = await loadCatalog(loadOptions)
      assert.equal(next.ok, false)
    }
  })
})

test('catalog errors do not persist source URL secrets', async (t) => {
  await withMemoryCache(t, async (memory) => {
    memory.respond(() => { throw new Error(`request failed for ${loadOptions.url}`) })
    const next = await loadCatalog(loadOptions)
    assert.equal(next.ok, false)
    assert.equal(next.reason, 'could not read catalog')
    assert.equal(next.reason.includes('private-value'), false)
  })
})

test('catalog fetch enforces the actual UTF-8 response byte limit', async (t) => {
  await withMemoryCache(t, async (memory) => {
    const text = JSON.stringify(catalog({ a: [{ id: 'model', name: '中'.repeat(100) }] }))
    memory.respond(() => new Response(text))
    const maxBytes = text.length + 1
    assert.ok(Buffer.byteLength(text) > maxBytes)
    const next = await fetchCatalog({ ...loadOptions, maxBytes })
    assert.equal(next.ok, false)
    assert.match(next.reason, /exceeds.*bytes/)
  })
})

test('catalog fetch relays the caller abort signal', async (t) => {
  await withMemoryCache(t, async (memory) => {
    const controller = new AbortController()
    controller.abort(new Error('private abort reason'))
    memory.respond((_url, { signal }) => {
      assert.equal(signal.aborted, true)
      throw signal.reason
    })
    const next = await fetchCatalog({ ...loadOptions, signal: controller.signal })
    assert.equal(next.ok, false)
    assert.equal(next.reason, 'catalog download was aborted')
  })
})
