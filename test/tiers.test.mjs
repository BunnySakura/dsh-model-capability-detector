import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildIndex, toLookup } from '../lib/catalog.js'
import { capabilitiesOf } from '../lib/detect.js'
import { applyAlias, nameKeys } from '../lib/names.js'
import { hasUpgradable, mergeDetected } from '../lib/plan.js'
import { validateField } from '../lib/settings.js'
import { DEFAULT_SOURCE_URLS, buildSourceIndex, loadThirdParty, pickAgreed, sourceUrl, toSourceLookup, voteFor } from '../lib/sources.js'
import { rankOf, resolveTiered } from '../lib/tiers.js'

const roundTrip = (value) => JSON.parse(JSON.stringify(value))
const source = (name, body) => toSourceLookup(roundTrip(buildSourceIndex(name, body)))
const openrouter = (entries) => source('openrouter', { data: entries })
const litellm = (table) => source('litellm', table)
const empty = toLookup(undefined)

test('name keys fold separators, provider prefixes and variants, but not short numeric suffixes', () => {
  assert.equal(nameKeys('anthropic/claude-sonnet-4.5:free').compact, 'claudesonnet45')
  assert.equal(nameKeys('claude-sonnet-4-5-20250929').family, 'claudesonnet45')
  assert.equal(nameKeys('claude-sonnet-4-5-20250929').compact, 'claudesonnet4520250929')
  assert.equal(nameKeys('gpt-4o-2024-08-06').family, 'gpt4o')
  assert.equal(nameKeys('deepseek-v4.1-flash-1017').family, 'deepseekv41flash1017')
  assert.notEqual(nameKeys('deepseek-v4.1-flash-0423').family, nameKeys('deepseek-v4.1-flash-1017').family)
})

test('aliases match case-insensitively, exactly, and never chain', () => {
  const aliases = { 'my-gw-gpt': 'gpt-4o', 'gpt-4o': 'something-else' }
  assert.equal(applyAlias(aliases, 'MY-GW-GPT'), 'gpt-4o')
  assert.equal(applyAlias(aliases, 'my-gw-gpt-2'), 'my-gw-gpt-2')
  assert.equal(applyAlias(undefined, 'x'), 'x')
})

test('API fields with unclear meaning become hints, clear ones stay definite', () => {
  const ambiguous = capabilitiesOf({ id: 'x', max_input_tokens: 1000, max_tokens: 500 })
  assert.equal(ambiguous.contextWindow, undefined)
  assert.equal(ambiguous.maxTokens, undefined)
  assert.deepEqual(ambiguous.hints, { contextWindow: 1000, maxTokens: 500 })
  const clear = capabilitiesOf({ id: 'x', context_length: 9000, max_input_tokens: 1000, max_completion_tokens: 700, max_tokens: 500 })
  assert.equal(clear.contextWindow, 9000)
  assert.equal(clear.maxTokens, 700)
  assert.equal(clear.hints, undefined)
})

test('third-party values need two agreeing sources', () => {
  const body = { data: [{ id: 'vendor/model-x', context_length: 128000, top_provider: { max_completion_tokens: 8000 }, architecture: { input_modalities: ['text', 'image'] } }] }
  const one = resolveTiered(empty, { openrouter: source('openrouter', body) }, 'model-x')
  assert.equal(one.safe.contextWindow, undefined)
  assert.equal(one.reasons.contextWindow, 'single-third-party-source')

  const both = resolveTiered(empty, {
    openrouter: source('openrouter', body),
    litellm: litellm({ 'model-x': { max_input_tokens: 128000, max_output_tokens: 8000, mode: 'chat', supports_vision: true } }),
  }, 'model-x')
  assert.equal(both.status, 'resolved')
  assert.equal(both.safe.contextWindow, 128000)
  assert.equal(both.safe.maxTokens, 8000)
  assert.deepEqual(both.safe.input, ['text', 'image'])
  assert.equal(both.sources.contextWindow.kind, 'third-party-consensus')
  assert.deepEqual(both.sources.contextWindow.sources.sort(), ['litellm', 'openrouter'])
  assert.equal(both.safe.reasoningEfforts, undefined, 'levels come from original records only')
})

test('a disagreeing third-party source blocks the value instead of picking one', () => {
  const answer = resolveTiered(empty, {
    openrouter: openrouter([{ id: 'vendor/model-y', context_length: 1000000 }]),
    litellm: litellm({ 'model-y': { max_input_tokens: 200000, mode: 'chat' } }),
  }, 'model-y')
  assert.equal(answer.safe.contextWindow, undefined)
  assert.equal(answer.reasons.contextWindow, 'third-party-conflict')
})

test('the primary listing outranks its variants inside one source', () => {
  const lookup = openrouter([
    { id: 'vendor/model-p:free', context_length: 32000 },
    { id: 'vendor/model-p', context_length: 128000 },
  ])
  assert.equal(voteFor(lookup, 'model-p').context, 128000)
  const split = openrouter([{ id: 'vendor/model-q:a', context_length: 1000 }, { id: 'vendor/model-q:b', context_length: 2000 }])
  assert.equal(voteFor(split, 'model-q').context, 'conflict')
})

test('models.dev votes with its publishers\u0027 agreed value and abstains when they split evenly', () => {
  const catalog = (second) => toLookup(roundTrip(buildIndex({
    one: { models: { a: { id: 'model-z', limit: { context: 64000, output: 4000 }, modalities: { input: ['text'] } } } },
    two: { models: { a: { id: 'model-z', limit: { context: second, output: 4000 }, modalities: { input: ['text'] } } } },
  })))
  const third = { openrouter: openrouter([{ id: 'vendor/model-z', context_length: 64000 }]) }
  assert.equal(resolveTiered(catalog(64000), third, 'model-z').safe.contextWindow, 64000)
  const split = resolveTiered(catalog(32000), third, 'model-z')
  assert.equal(split.safe.contextWindow, undefined)
  assert.equal(split.reasons.contextWindow, 'single-third-party-source', 'an evenly split source abstains instead of vetoing')
})

test('an alias redirects the lookup to the standard model', () => {
  const answer = resolveTiered(empty, undefined, 'MY-GW', { aliases: { 'my-gw': 'deepseek-v4.1-flash-1017' } })
  assert.equal(answer.aliased, true)
  assert.equal(answer.safe.contextWindow, 1048576)
  assert.equal(answer.sources.contextWindow.kind, 'official-verified')
})

test('source rank follows the agreed priority', () => {
  const kinds = ['channel-api', 'official-verified', 'original-provider-mirror', 'third-party-consensus', 'api-hint', 'legacy-catalog']
  const ranks = kinds.map((kind) => rankOf({ kind }))
  assert.deepEqual([...ranks].sort((a, b) => b - a), ranks)
  assert.equal(rankOf({ kind: 'mystery' }) < rankOf({ kind: 'legacy-catalog' }), true)
})

const catalogAnswer = (value, kind = 'original-provider-mirror') => ({
  status: 'resolved', safe: { contextWindow: value }, sources: { contextWindow: { kind, channelVerified: false } },
})
const providers = (model) => ({ route: { baseURL: 'https://x.test/v1', models: [model] } })
const options = (extra) => ({ resolve: () => catalogAnswer(5000), allowedFields: ['contextWindow'], ...extra })

test('merge order: channel API, then catalog, then API hints', () => {
  const hint = new Map([['route', new Map([['m', { id: 'm', hints: { contextWindow: 1000 } }]])]])
  assert.equal(mergeDetected(providers({ id: 'm' }), hint, false, { resolve: () => undefined, allowedFields: [] }).providers.route.models[0].contextWindow, 1000)
  assert.equal(mergeDetected(providers({ id: 'm' }), hint, false, options()).providers.route.models[0].contextWindow, 5000, 'catalog outranks a hint')
  const api = new Map([['route', new Map([['m', { id: 'm', contextWindow: 2000, hints: { contextWindow: 1000 } }]])]])
  assert.equal(mergeDetected(providers({ id: 'm' }), api, false, options()).providers.route.models[0].contextWindow, 2000, 'API outranks catalog')
})

test('plugin-written lower-tier values upgrade; hand-typed or edited values never do', () => {
  const receipts = { weak: { value: 1000, source: { kind: 'api-hint' } } }
  const receiptFor = () => receipts.weak
  const run = (model, extra = {}) => mergeDetected(providers(model), new Map(), false, options({ receiptFor, upgrade: true, ...extra }))
  const upgraded = run({ id: 'm', contextWindow: 1000 })
  assert.equal(upgraded.providers.route.models[0].contextWindow, 5000)
  assert.deepEqual(upgraded.upgrades, [{ route: 'route', model: 'm', field: 'contextWindow', from: 'api-hint', to: 'original-provider-mirror' }])
  assert.equal(run({ id: 'm', contextWindow: 1234 }).providers.route.models[0].contextWindow, 1234, 'value no longer matches the receipt: the user edited it')
  assert.equal(mergeDetected(providers({ id: 'm', contextWindow: 1000 }), new Map(), false, options({ upgrade: true })).providers.route.models[0].contextWindow, 1000, 'no receipt: the user typed it')
  assert.equal(run({ id: 'm', contextWindow: 1000 }, { upgrade: false }).providers.route.models[0].contextWindow, 1000)
  const strong = mergeDetected(providers({ id: 'm', contextWindow: 1000 }), new Map(), false, options({ upgrade: true, receiptFor: () => ({ value: 1000, source: { kind: 'channel-api' } }) }))
  assert.equal(strong.providers.route.models[0].contextWindow, 1000, 'a stronger or equal receipt is final')
})

test('better evidence for an unchanged value refreshes only its receipt', () => {
  const result = mergeDetected(providers({ id: 'm', contextWindow: 5000 }), new Map(), false,
    options({ receiptFor: () => ({ value: 5000, source: { kind: 'api-hint' } }), upgrade: true }))
  assert.equal(result.changes.length, 0)
  assert.equal(result.provenance.length, 1)
  assert.equal(result.provenance[0].source.kind, 'original-provider-mirror')
})

test('hasUpgradable only reports plugin-written values below official rank', () => {
  const model = { id: 'm', contextWindow: 1000 }
  assert.equal(hasUpgradable(providers(model), () => ({ value: 1000, source: { kind: 'third-party-consensus' } })), true)
  assert.equal(hasUpgradable(providers(model), () => ({ value: 1000, source: { kind: 'original-provider-mirror' } })), true)
  assert.equal(hasUpgradable(providers(model), () => ({ value: 1000, source: { kind: 'official-verified' } })), false)
  assert.equal(hasUpgradable(providers(model), () => ({ value: 999, source: { kind: 'api-hint' } })), false)
  assert.equal(hasUpgradable(providers(model), () => undefined), false)
})

test('alias settings are normalized and bounded', () => {
  assert.deepEqual(validateField('modelAliases', { ' GPT-X ': ' gpt-4o ' }), { ok: true, value: { 'gpt-x': 'gpt-4o' } })
  assert.equal(validateField('modelAliases', ['a']).ok, false)
  assert.equal(validateField('modelAliases', { a: '' }).ok, false)
  assert.equal(validateField('modelAliases', { a: 'b\nc' }).ok, false)
  assert.equal(validateField('modelAliases', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']))).ok, false)
})

test('third-party sources load independently, cache, and tolerate one failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-third-'))
  const original = globalThis.fetch
  let calls = 0
  let failLitellm = false
  globalThis.fetch = async (url) => {
    calls++
    if (String(url).includes('openrouter')) return Response.json({ data: [{ id: 'v/m', context_length: 1000 }] })
    if (failLitellm) throw new Error('offline')
    return Response.json({ m: { max_input_tokens: 1000, mode: 'chat' } })
  }
  try {
    const first = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000 })
    assert.deepEqual(first.status, { openrouter: 'network', litellm: 'network' })
    const again = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000 })
    assert.deepEqual(again.status, { openrouter: 'cache', litellm: 'cache' })
    assert.equal(calls, 2)
    failLitellm = true
    const partial = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000, now: Date.now() + 120000 })
    assert.equal(partial.status.openrouter, 'network')
    assert.equal(partial.status.litellm, 'stale-cache', 'a failed refresh falls back to the previous snapshot')
    assert.equal(voteFor(partial.lookups.litellm, 'm').context, 1000)
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }) }
})

test('a configured mirror is requested instead of the default, and caches do not cross addresses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-mirror-'))
  const original = globalThis.fetch
  const requested = []
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    if (String(url).includes('openrouter') || String(url).includes('or-mirror')) {
      return Response.json({ data: [{ id: 'v/m', context_length: 1000 }] })
    }
    return Response.json({ m: { max_input_tokens: 1000, mode: 'chat' } })
  }
  const urls = { openrouter: 'https://or-mirror.example.test/models', litellm: 'https://ll-mirror.example.test/table.json' }
  try {
    const first = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000, urls })
    assert.deepEqual(first.status, { openrouter: 'network', litellm: 'network' })
    assert.deepEqual([...requested].sort(), [urls.litellm, urls.openrouter].sort())
    assert.ok(requested.every((url) => !Object.values(DEFAULT_SOURCE_URLS).includes(url)), 'the default address is not contacted')

    requested.length = 0
    const again = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000, urls })
    assert.deepEqual(again.status, { openrouter: 'cache', litellm: 'cache' })
    assert.equal(requested.length, 0)

    // Back on the default address the mirror snapshot is not reused, even while fresh.
    const defaults = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000 })
    assert.deepEqual(defaults.status, { openrouter: 'network', litellm: 'network' })
    assert.deepEqual([...requested].sort(), Object.values(DEFAULT_SOURCE_URLS).sort())
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }) }
})

test('a snapshot written without an address key still belongs to the default address', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-legacy-'))
  const original = globalThis.fetch
  globalThis.fetch = async (url) => (String(url).includes('openrouter')
    ? Response.json({ data: [{ id: 'v/m', context_length: 1000 }] })
    : Response.json({ m: { max_input_tokens: 1000, mode: 'chat' } }))
  try {
    await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000 })
    const path = join(home, 'cache', 'model-capability-detector', 'thirdparty.json')
    const { readFile, writeFile } = await import('node:fs/promises')
    const stored = JSON.parse(await readFile(path, 'utf8'))
    for (const entry of Object.values(stored.sources)) delete entry.urlKey
    await writeFile(path, JSON.stringify(stored))
    let calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({}) }
    const reread = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000 })
    assert.deepEqual(reread.status, { openrouter: 'cache', litellm: 'cache' })
    assert.equal(calls, 0)
    const mirrored = await loadThirdParty({ homePath: home, ttlMs: 60000, timeoutMs: 1000, urls: { openrouter: 'https://or-mirror.example.test/m' } })
    assert.equal(mirrored.status.openrouter, 'failed', 'a legacy snapshot is not evidence about a mirror')
    assert.equal(mirrored.status.litellm, 'cache')
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }) }
})

test('source addresses accept only plain http(s) and fall back to the default otherwise', () => {
  assert.equal(sourceUrl('openrouter', undefined), DEFAULT_SOURCE_URLS.openrouter)
  assert.equal(sourceUrl('openrouter', ''), DEFAULT_SOURCE_URLS.openrouter)
  assert.equal(sourceUrl('openrouter', 'file:///etc/passwd'), DEFAULT_SOURCE_URLS.openrouter)
  assert.equal(sourceUrl('litellm', 'https://user:pass@example.test/t.json'), DEFAULT_SOURCE_URLS.litellm)
  assert.equal(sourceUrl('litellm', 'not a url'), DEFAULT_SOURCE_URLS.litellm)
  assert.equal(sourceUrl('litellm', 'https://mirror.example.test/t.json'), 'https://mirror.example.test/t.json')
  for (const key of ['openrouterUrl', 'litellmUrl']) {
    assert.equal(validateField(key, 'ftp://example.test/x').ok, false)
    assert.equal(validateField(key, 'https://user:pass@example.test/x').ok, false)
    assert.equal(validateField(key, 'https://example.test/x').ok, true)
  }
})

test('numbers within the tolerance agree and the smaller value is used', () => {
  const picked = pickAgreed([{ value: 65536 }, { value: 65535 }])
  assert.equal(picked.value, 65535)
  assert.equal(pickAgreed([{ value: 204800 }, { value: 200000 }, { value: 202752 }]).value, 200000)
  assert.equal(pickAgreed([{ value: 100000 }, { value: 106000 }, { value: 106000 }]).value, 106000, 'the larger cluster wins; 6% apart is two clusters')
  assert.equal(pickAgreed([{ value: 131072 }, { value: 163840 }]), undefined, 'a 25% gap on a tie is not agreement')
})

test('the larger agreeing group wins; exact ties and non-numbers stay strict', () => {
  const outlier = pickAgreed([{ value: 256000 }, { value: 258048 }, { value: 262144 }, { value: 1048576 }])
  assert.equal(outlier.value, 256000)
  assert.equal(outlier.members.length, 3)
  assert.equal(pickAgreed([{ value: 1 }, { value: 1000000 }]), undefined)
  assert.equal(pickAgreed([{ value: true }, { value: false }]), undefined)
  assert.equal(pickAgreed([{ value: true }, { value: true }, { value: false }]).value, true)
  assert.equal(pickAgreed([]), undefined)
})

test('a small spread between sources no longer blocks the value', () => {
  const answer = resolveTiered(empty, {
    openrouter: openrouter([{ id: 'v/model-s', context_length: 65536 }]),
    litellm: litellm({ 'model-s': { max_input_tokens: 65535, mode: 'chat' } }),
  }, 'model-s')
  assert.equal(answer.safe.contextWindow, 65535)
  assert.equal(answer.sources.contextWindow.kind, 'third-party-consensus')
})

test('two sources outvote a third that disagrees', () => {
  const catalog = toLookup(roundTrip(buildIndex({
    one: { models: { a: { id: 'model-t', limit: { context: 200000 } } } },
  })))
  const answer = resolveTiered(catalog, {
    openrouter: openrouter([{ id: 'v/model-t', context_length: 1000000 }]),
    litellm: litellm({ 'model-t': { max_input_tokens: 200000, mode: 'chat' } }),
  }, 'model-t')
  assert.equal(answer.safe.contextWindow, 200000, 'litellm and models.dev agree against the 1M beta figure')
  assert.deepEqual(answer.sources.contextWindow.sources.sort(), ['litellm', 'models_dev'])
})

test('rows of one source that spread within tolerance vote as one value', () => {
  const lookup = litellm({
    'dashscope/model-u': { max_input_tokens: 258048, mode: 'chat' },
    'novita/model-u': { max_input_tokens: 262144, mode: 'chat' },
    'deepinfra/model-u': { max_input_tokens: 256000, mode: 'chat' },
  })
  assert.equal(voteFor(lookup, 'model-u').context, 256000)
})