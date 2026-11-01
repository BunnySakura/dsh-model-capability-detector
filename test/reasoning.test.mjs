/**
 * Reasoning support: the vendor allowlist, the "does it reason" signal, presets,
 * the merge rules around them and the opt-in probe. Everything runs on synthetic
 * data and a fake `fetch`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildIndex, toLookup } from '../lib/catalog.js'
import { capabilitiesOf } from '../lib/detect.js'
import { buildOfficialRecords, readVendors, resolveOfficial } from '../lib/official.js'
import { UPGRADE_BELOW_RANK, mergeDetected } from '../lib/plan.js'
import { PRESET_IDS, PRESETS, cleanEfforts, presetEfforts, readPresets } from '../lib/presets.js'
import { PROBE_LEVELS, completionsUrl, probeModel, showsReasoning } from '../lib/probe.js'
import { createSettingsStore, describeFields, validateField } from '../lib/settings.js'
import { buildSourceIndex, toSourceLookup } from '../lib/sources.js'
import { rankOf, resolveTiered } from '../lib/tiers.js'

const roundTrip = (value) => JSON.parse(JSON.stringify(value))
const lookupOf = (document) => toLookup(roundTrip(buildIndex(document)))
const third = (name, body) => toSourceLookup(roundTrip(buildSourceIndex(name, body)))
const empty = toLookup(undefined)

async function withTempFile(text, body) {
  const directory = await mkdtemp(join(tmpdir(), 'mcd-data-'))
  try {
    const file = join(directory, 'data.json')
    await writeFile(file, text)
    return await body(file)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

// ---- the vendor allowlist ---------------------------------------------------

test('the shipped allowlist covers the maintained model families, once per provider', () => {
  const rows = readVendors()
  const vendors = new Set(rows.map((row) => row.vendor))
  for (const family of ['openai', 'anthropic', 'deepseek', 'google', 'xai', 'zhipuai', 'moonshotai', 'alibaba']) {
    assert.ok(vendors.has(family), `${family} is trusted`)
  }
  assert.equal(new Set(rows.map((row) => row.provider)).size, rows.length, 'a provider is listed once')
  for (const row of rows) assert.ok(row.docs.length > 0 && row.docs.every(({ host }) => /^[a-z0-9.-]+$/.test(host)), `${row.provider}: documentation hosts`)
})

test('malformed allowlist rows are dropped instead of widening trust', async () => {
  const text = JSON.stringify([
    { vendor: 'ok', provider: 'ok', docs: ['docs.ok.test', 'docs.ok.test/help/'] },
    { vendor: 'no-docs', provider: 'x', docs: [] },
    { vendor: 'bad-doc', provider: 'y', docs: ['https://evil.test/x', 'a b'] },
    { vendor: 'bad-regex', provider: 'z', docs: ['docs.z.test'], models: '(' },
    { provider: 'no-vendor', docs: ['docs.n.test'] },
    'nonsense', null,
  ])
  await withTempFile(text, (file) => {
    const rows = readVendors(file)
    assert.deepEqual(rows.map((row) => row.provider), ['ok'])
    assert.deepEqual(rows[0].docs, [{ host: 'docs.ok.test', prefix: '' }, { host: 'docs.ok.test', prefix: '/help' }])
  })
  assert.deepEqual(readVendors(join(tmpdir(), 'mcd-missing-file.json')), [])
  await withTempFile('{"not":"a list"}', (file) => assert.deepEqual(readVendors(file), []))
})

const model = (extra = {}) => ({ limit: { context: 200000, output: 64000 }, modalities: { input: ['text'] }, ...extra })
const catalog = () => ({
  zhipuai: { id: 'zhipuai', doc: 'https://docs.bigmodel.cn/cn/guide/start/pricing', models: {
    'glm-5': model({ id: 'glm-5', canonical_model_id: 'zhipuai/glm-5', reasoning: true, reasoning_options: [{ type: 'toggle' }] }),
    'glm-air': model({ id: 'glm-air', canonical_model_id: 'zhipuai/glm-air', reasoning: false }),
  } },
  zai: { id: 'zai', doc: 'https://docs.z.ai/guides/overview/pricing', models: {
    'glm-5': model({ id: 'glm-5', canonical_model_id: 'zhipuai/glm-5', reasoning: true, reasoning_options: [{ type: 'toggle' }] }),
  } },
  alibaba: { id: 'alibaba', doc: 'https://www.alibabacloud.com/help/en/model-studio/models', models: {
    'qwen3.5-plus': model({ id: 'qwen3.5-plus', reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }] }),
    'deepseek-r1': model({ id: 'deepseek-r1', canonical_model_id: 'deepseek/deepseek-r1', reasoning: true }),
    'glm-5.2': model({ id: 'glm-5.2', reasoning: true }),
    'text-embedding-v4': model({ id: 'text-embedding-v4' }),
  } },
  reseller: { id: 'reseller', doc: 'https://reseller.test/docs', models: { 'glm-5': model({ id: 'glm-5', reasoning: false }) } },
})

test('only a vendor’s own models become original records; hosted models and strangers are skipped', () => {
  const records = buildOfficialRecords(catalog())
  const ids = records.map((record) => `${record.vendor}:${record.id}`).sort()
  assert.deepEqual(ids, ['alibaba:qwen3.5-plus', 'zhipuai:glm-5', 'zhipuai:glm-5', 'zhipuai:glm-air'])
  assert.equal(records.some((record) => record.id === 'deepseek-r1'), false, 'another company’s model hosted here is not original')
  assert.equal(records.some((record) => record.id === 'glm-5.2'), false, 'no canonical id and not the vendor’s naming')
  assert.equal(records.some((record) => record.id === 'text-embedding-v4'), false)
})

test('a documentation address must match both host and path prefix', () => {
  const rows = [{ vendor: 'alibaba', provider: 'alibaba', docs: [{ host: 'www.alibabacloud.com', prefix: '/help/en/model-studio' }], models: /^qwen/i }]
  const at = (doc) => buildOfficialRecords({ alibaba: { id: 'alibaba', doc, models: { 'qwen-x': model({ id: 'qwen-x' }) } } }, rows).length
  assert.equal(at('https://www.alibabacloud.com/help/en/model-studio/models'), 1)
  assert.equal(at('https://www.alibabacloud.com/help/en/model-studio'), 1)
  assert.equal(at('https://www.alibabacloud.com/help/en/model-studio-evil/models'), 0, 'a longer sibling path is not the prefix')
  assert.equal(at('https://www.alibabacloud.com/help/en/other/models'), 0)
  assert.equal(at('http://www.alibabacloud.com/help/en/model-studio/models'), 0, 'https only')
  assert.equal(at('https://user:pw@www.alibabacloud.com/help/en/model-studio/models'), 0)
  assert.equal(at('https://alibabacloud.com.evil.test/help/en/model-studio/models'), 0)
})

test('several providers of one vendor share an identity, and disagreement is withheld', () => {
  const document = catalog()
  document.zai.models['glm-5'].limit.context = 128000
  const answer = resolveOfficial(buildOfficialRecords(document), 'glm-5')
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.identity, 'zhipuai/glm-5')
  assert.deepEqual([...answer.withheld.contextWindow].sort((a, b) => a - b), [128000, 200000])
  assert.equal(answer.safe.contextWindow, undefined, 'two first-party records disagree')
  assert.equal(answer.safe.maxTokens, 64000, 'a field they agree on is kept')
})

// ---- does the model reason at all -------------------------------------------

test('an original record that only offers a toggle still says the model reasons', () => {
  const lookup = lookupOf(catalog())
  const toggle = resolveTiered(lookup, undefined, 'glm-5')
  assert.equal(toggle.safe.reasoningEfforts, undefined, 'no level is invented')
  assert.deepEqual(toggle.reasoningSupport, { state: 'yes', basis: 'official' })
  const plain = resolveTiered(lookup, undefined, 'glm-air')
  assert.deepEqual(plain.reasoningSupport, { state: 'no', basis: 'official' })
  const qwen = resolveTiered(lookup, undefined, 'qwen3.5-plus')
  assert.equal(qwen.reasoningSupport.state, 'yes', 'a token budget counts as reasoning')
})

test('third-party sources need two to agree that a model reasons, and silence is not a vote', () => {
  const orReasons = { data: [{ id: 'v/model-r', supported_parameters: ['temperature', 'reasoning'], context_length: 1000 }] }
  const orSilent = { data: [{ id: 'v/model-r', supported_parameters: ['temperature'], context_length: 1000 }] }
  const llReasons = { 'model-r': { max_input_tokens: 1000, mode: 'chat', supports_reasoning: true } }
  const one = resolveTiered(empty, { openrouter: third('openrouter', orReasons) }, 'model-r')
  assert.deepEqual(one.reasoningSupport, { state: 'unknown' })
  const two = resolveTiered(empty, { openrouter: third('openrouter', orReasons), litellm: third('litellm', llReasons) }, 'model-r')
  assert.equal(two.reasoningSupport.state, 'yes')
  assert.equal(two.reasoningSupport.basis, 'third-party')
  assert.deepEqual([...two.reasoningSupport.sources].sort(), ['litellm', 'openrouter'])
  const silent = resolveTiered(empty, { openrouter: third('openrouter', orSilent), litellm: third('litellm', llReasons) }, 'model-r')
  assert.equal(silent.reasoningSupport.state, 'unknown', 'a missing flag is not "no"')
  assert.equal(two.safe.reasoningEfforts, undefined, 'knowing it reasons does not name a level')
})

test('a publisher that lists the model as non-reasoning outvotes one claim but not two', () => {
  const lookup = lookupOf({ reseller: { id: 'reseller', doc: 'https://reseller.test', models: { 'model-q': model({ id: 'model-q', reasoning: false }) } } })
  const orReasons = third('openrouter', { data: [{ id: 'v/model-q', supported_parameters: ['reasoning'] }] })
  const llReasons = third('litellm', { 'model-q': { max_input_tokens: 10, mode: 'chat', supports_reasoning: true } })
  const split = resolveTiered(lookup, { openrouter: orReasons }, 'model-q')
  assert.equal(split.reasoningSupport.state, 'unknown', 'one yes against one no is a tie')
  const majority = resolveTiered(lookup, { openrouter: orReasons, litellm: llReasons }, 'model-q')
  assert.equal(majority.reasoningSupport.state, 'yes', 'two agree against one')
})

test('an ambiguous name returns an empty but well-formed answer', () => {
  const records = [
    { vendor: 'a', id: 'm1', canonical: 'a/m1', safe: {}, doc: 'https://a.test' },
    { vendor: 'b', id: 'm1', canonical: 'b/m1', safe: {}, doc: 'https://b.test' },
  ]
  const answer = resolveTiered({ officialRecords: records, groups: new Map(), reach: new Map() }, undefined, 'm1')
  assert.equal(answer.status, 'ambiguous')
  assert.deepEqual(answer.safe, {})
  assert.deepEqual(answer.reasoningSupport, { state: 'unknown' })
  assert.deepEqual(answer.reasons, {})
})

test('a channel listing that says a model reasons, without levels, becomes a hint only', () => {
  assert.equal(capabilitiesOf({ id: 'x', supported_parameters: ['reasoning'] }).hints.reasoning, true)
  assert.equal(capabilitiesOf({ id: 'x', reasoning: { mandatory: true, default_enabled: true } }).hints.reasoning, true)
  assert.equal(capabilitiesOf({ id: 'x', supports_reasoning: true }).hints.reasoning, true)
  const named = capabilitiesOf({ id: 'x', reasoning: { supported_efforts: ['low', 'high'] } })
  assert.deepEqual(named.reasoningEfforts, { low: 'low', high: 'high' })
  assert.equal(named.hints, undefined, 'real levels need no hint')
  assert.equal(capabilitiesOf({ id: 'x', reasoning: false }).hints, undefined)
  assert.equal(capabilitiesOf({ id: 'x', supports_reasoning: false }).hints, undefined)
  assert.equal(capabilitiesOf({ id: 'x', supported_parameters: ['temperature'] }).hints, undefined)
})

// ---- presets ----------------------------------------------------------------

test('a preset is a complete dictionary DSH would accept', () => {
  for (const id of ['openai', 'deepseek', 'toggle', 'extended']) assert.ok(PRESET_IDS.includes(id), id)
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.deepEqual(cleanEfforts(preset.efforts), preset.efforts, `${id} survives validation unchanged`)
    assert.ok(Object.keys(preset.efforts).some((level) => level !== 'off'), `${id} offers a thinking level`)
  }
  assert.equal(PRESET_IDS.includes('none'), false, '"none" means no preset')
})

test('invalid reasoning dictionaries are refused', () => {
  assert.equal(cleanEfforts(undefined), undefined)
  assert.equal(cleanEfforts([]), undefined)
  assert.equal(cleanEfforts({}), undefined)
  assert.equal(cleanEfforts({ off: null }), undefined, 'needs a level besides off')
  assert.equal(cleanEfforts({ low: null }), undefined, 'only off may have no wire value')
  assert.equal(cleanEfforts({ low: '' }), undefined)
  assert.equal(cleanEfforts({ low: 3 }), undefined)
  assert.equal(cleanEfforts({ turbo: 'x' }), undefined, 'unknown level')
  assert.equal(cleanEfforts({ low: 'a'.repeat(65) }), undefined)
  assert.equal(cleanEfforts({ low: 'a\nb' }), undefined)
  assert.deepEqual(cleanEfforts({ high: 'high', off: null, low: 'low' }), { off: null, low: 'low', high: 'high' }, 'escalation order')
})

test('presetEfforts hands out copies and ignores unknown ids', () => {
  const copy = presetEfforts('deepseek')
  copy.low = 'changed'
  assert.equal(presetEfforts('deepseek').low, 'low')
  assert.equal(presetEfforts('nope'), undefined)
  assert.equal(presetEfforts('__proto__'), undefined)
  assert.equal(presetEfforts('toString'), undefined)
  assert.equal(presetEfforts(undefined), undefined)
})

test('a broken presets file yields only its valid entries', async () => {
  const text = JSON.stringify({
    good: { description: 'fine', efforts: { off: null, high: 'high' } },
    none: { efforts: { high: 'high' } },
    'Bad Id': { efforts: { high: 'high' } },
    empty: { efforts: {} },
    junk: 5,
  })
  await withTempFile(text, (file) => assert.deepEqual(Object.keys(readPresets(file)), ['good']))
  assert.deepEqual(readPresets(join(tmpdir(), 'mcd-missing-presets.json')), {})
})

test('the preset and probe settings validate and default to off', () => {
  assert.equal(validateField('reasoningPreset', 'none').ok, true)
  assert.equal(validateField('reasoningPreset', 'deepseek').ok, true)
  assert.equal(validateField('reasoningPreset', 'bogus').ok, false)
  assert.equal(validateField('probeEnabled', true).ok, true)
  assert.equal(validateField('probeEnabled', 'yes').ok, false)
  const store = createSettingsStore({})
  assert.equal(store.effective().reasoningPreset, 'none')
  assert.equal(store.effective().probeEnabled, false)
  assert.deepEqual(describeFields().reasoningPreset.values.slice(0, 1), ['none'])
})

// ---- merging with a preset --------------------------------------------------

const answer = (support, extra = {}) => ({ status: 'resolved', safe: {}, withheld: {}, sources: {}, reasoningSupport: support, ...extra })
const run = (resolve, preset, detected = new Map(), providers = { r: { models: [{ id: 'm' }] } }, extra = {}) => mergeDetected(providers, detected, false, {
  resolve, allowedFields: ['input', 'reasoningEfforts'], preset, ...extra,
})
const TOGGLE = { id: 'toggle', efforts: { off: null, high: 'high' } }

test('a preset fills the levels when the sources agree the model reasons', () => {
  const result = run(() => answer({ state: 'yes', basis: 'third-party' }), TOGGLE)
  assert.deepEqual(result.providers.r.models[0].reasoningEfforts, { off: null, high: 'high' })
  assert.equal(result.provenance[0].source.kind, 'preset')
  assert.equal(result.provenance[0].source.preset, 'toggle')
  assert.deepEqual(result.fallbacks, [], 'a preset is not reported as coming from a catalog')
})

test('a preset waits for evidence: unknown, "no", a refusal or no preset fill nothing', () => {
  for (const support of [{ state: 'unknown' }, { state: 'no', basis: 'official' }]) {
    assert.equal(run(() => answer(support), TOGGLE).providers.r.models[0].reasoningEfforts, undefined, support.state)
  }
  assert.equal(run(() => answer({ state: 'yes' }, { withheld: { reasoningEfforts: [] } }), TOGGLE).providers.r.models[0].reasoningEfforts, undefined, 'original records disagree')
  assert.equal(run(() => answer({ state: 'yes' }), undefined).providers.r.models[0].reasoningEfforts, undefined, 'preset setting is off')
})

test('a channel hint alone can trigger the preset, but real levels always win', () => {
  const hinted = new Map([['r', new Map([['m', { id: 'm', hints: { reasoning: true } }]])]])
  assert.deepEqual(run(() => undefined, TOGGLE, hinted).providers.r.models[0].reasoningEfforts, { off: null, high: 'high' })
  const named = new Map([['r', new Map([['m', { id: 'm', reasoningEfforts: { low: 'low', high: 'high' } }]])]])
  assert.deepEqual(run(() => answer({ state: 'yes' }), TOGGLE, named).providers.r.models[0].reasoningEfforts, { low: 'low', high: 'high' })
  const official = run(() => answer({ state: 'yes' }, { safe: { reasoningEfforts: { high: 'high', max: 'max' } }, sources: { reasoningEfforts: { kind: 'original-provider-mirror' } } }), TOGGLE)
  assert.deepEqual(official.providers.r.models[0].reasoningEfforts, { high: 'high', max: 'max' })
  assert.equal(official.provenance[0].source.kind, 'original-provider-mirror')
})

test('a value the user set is never replaced by a preset', () => {
  const providers = { r: { models: [{ id: 'm', reasoningEfforts: false }, { id: 'n', reasoningEfforts: { low: 'low' } }] } }
  const result = run(() => answer({ state: 'yes' }), TOGGLE, new Map(), providers)
  assert.equal(result.providers.r.models[0].reasoningEfforts, false)
  assert.deepEqual(result.providers.r.models[1].reasoningEfforts, { low: 'low' })
  assert.deepEqual(result.changes, [])
})

test('a real source replaces a value the plugin guessed from a preset, but not one you chose', () => {
  const guessed = { off: null, high: 'high' }
  const providers = { r: { models: [{ id: 'm', reasoningEfforts: guessed }] } }
  const better = () => answer({ state: 'yes' }, { safe: { reasoningEfforts: { low: 'low', high: 'high' } }, sources: { reasoningEfforts: { kind: 'original-provider-mirror' } } })
  const upgraded = run(better, undefined, new Map(), providers, { upgrade: true, receiptFor: () => ({ value: guessed, source: { kind: 'preset' } }) })
  assert.deepEqual(upgraded.providers.r.models[0].reasoningEfforts, { low: 'low', high: 'high' })
  assert.deepEqual(upgraded.upgrades.map((entry) => [entry.from, entry.to]), [['preset', 'original-provider-mirror']])
  const chosen = run(better, undefined, new Map(), providers, { upgrade: true, receiptFor: () => ({ value: guessed, source: { kind: 'manual' } }) })
  assert.deepEqual(chosen.providers.r.models[0].reasoningEfforts, guessed, 'a manual receipt is never outranked')
  assert.deepEqual(chosen.upgrades, [])
})

test('source ranks put a preset below every real source and a manual choice above all', () => {
  const order = ['manual', 'channel-api', 'official-verified', 'original-provider-mirror', 'official-sibling', 'third-party-consensus', 'api-hint', 'preset', 'legacy-catalog']
  const ranks = order.map((kind) => rankOf({ kind }))
  assert.deepEqual([...ranks].sort((a, b) => b - a), ranks, 'strictly descending in this order')
  assert.equal(new Set(ranks).size, ranks.length)
  assert.equal(rankOf({ kind: 'preset' }) < UPGRADE_BELOW_RANK, true, 'a preset can be upgraded')
  assert.equal(rankOf({ kind: 'manual' }) < UPGRADE_BELOW_RANK, false, 'a manual choice cannot')
})

// ---- the probe --------------------------------------------------------------

/** A fake OpenAI-compatible channel. */
function fakeChannel(options = {}) {
  const { accepts = ['low', 'medium', 'high'], validates = true, thinksByDefault = false, reasonsOn = accepts, tokenField = 'max_tokens', status } = options
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seen.push({ url: String(url), init, body })
    if (options.throws !== undefined) throw options.throws
    if (status !== undefined) return new Response('{"error":"nope"}', { status })
    if (body[tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'] !== undefined) {
      return new Response(`{"error":"use ${tokenField}"}`, { status: 400 })
    }
    const effort = body.reasoning_effort
    if (effort !== undefined && validates && !accepts.includes(effort)) return new Response('{"error":"bad reasoning_effort"}', { status: 400 })
    const reasoned = thinksByDefault || (effort !== undefined && reasonsOn.includes(effort))
    return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { completion_tokens_details: { reasoning_tokens: reasoned ? 40 : 0 } } })
  }
  return { seen, restore: () => { globalThis.fetch = original } }
}
const probe = (extra = {}) => probeModel({ baseURL: 'https://channel.example.test/v1', apiKey: 'sk-probe-secret', headers: { 'x-team': 'a' }, model: 'm-1', timeoutMs: 2000, ...extra })

test('a channel that validates levels gets a proposal built from what visibly reasons', async () => {
  const channel = fakeChannel()
  try {
    const result = await probe()
    assert.equal(result.ok, true)
    assert.equal(result.verdict, 'proposal')
    assert.equal(result.validates, true)
    assert.equal(result.baseline.reasoned, false)
    assert.deepEqual(result.proposal, { off: null, low: 'low', medium: 'medium', high: 'high' })
    assert.deepEqual(result.levels, { minimal: 'rejected', low: 'reasoned', medium: 'reasoned', high: 'reasoned', xhigh: 'rejected', max: 'rejected' })
    assert.equal(result.requests, 2 + PROBE_LEVELS.length, 'a baseline, an invalid-level control and one request per level')
  } finally { channel.restore() }
})

test('the request is plain: fixed prompt, small limit, redirects refused, credentials in headers only', async () => {
  const channel = fakeChannel()
  try {
    const result = await probe()
    assert.equal(channel.seen[0].url, 'https://channel.example.test/v1/chat/completions')
    for (const { init, body } of channel.seen) {
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.get('authorization'), 'Bearer sk-probe-secret')
      assert.equal(init.headers.get('x-team'), 'a')
      assert.equal(body.stream, false)
      assert.equal(body.model, 'm-1')
      assert.ok(body.max_tokens <= 256)
      assert.equal(body.messages.length, 1)
      assert.equal(JSON.stringify(body).includes('sk-probe-secret'), false, 'the key is not in the body')
    }
    assert.equal(channel.seen[0].body.reasoning_effort, undefined, 'the baseline names no level')
    const text = JSON.stringify(result)
    assert.equal(text.includes('sk-probe-secret'), false)
    assert.equal(text.includes('channel.example.test'), false, 'the result carries no address')
  } finally { channel.restore() }
})

test('a model that reasons by default makes acceptance meaningful only when the channel validates', async () => {
  let channel = fakeChannel({ thinksByDefault: true })
  try {
    const result = await probe()
    assert.equal(result.baseline.reasoned, true)
    assert.deepEqual(result.proposal, { low: 'low', medium: 'medium', high: 'high' }, 'no "off": it cannot be switched off')
  } finally { channel.restore() }
  channel = fakeChannel({ thinksByDefault: true, validates: false })
  try {
    const result = await probe()
    assert.equal(result.verdict, 'unverifiable')
    assert.equal(result.validates, false)
    assert.equal(result.proposal, undefined)
  } finally { channel.restore() }
})

test('acceptance without any sign of reasoning proposes nothing', async () => {
  const channel = fakeChannel({ validates: false, reasonsOn: [] })
  try {
    const result = await probe()
    assert.equal(result.verdict, 'no-evidence')
    assert.equal(result.proposal, undefined)
  } finally { channel.restore() }
})

test('a channel that wants the other spelling of the output limit is retried once', async () => {
  const channel = fakeChannel({ tokenField: 'max_completion_tokens' })
  try {
    const result = await probe()
    assert.equal(result.ok, true)
    assert.equal(channel.seen[0].body.max_tokens !== undefined, true, 'first attempt used max_tokens')
    assert.equal(channel.seen.at(-1).body.max_completion_tokens !== undefined, true, 'then max_completion_tokens')
    assert.equal(result.requests, 3 + PROBE_LEVELS.length, 'only the first request was repeated')
  } finally { channel.restore() }
})

test('channel failures end the probe with a reason and nothing else', async () => {
  const cases = [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not-found'], [429, 'rate-limited'], [500, 'server-error'], [503, 'server-error'], [402, 'refused'], [400, 'baseline-rejected']]
  for (const [status, reason] of cases) {
    const channel = fakeChannel({ status })
    try {
      const result = await probe()
      assert.deepEqual(result, { ok: false, reason }, String(status))
      assert.equal(channel.seen.length, 1, 'a fatal error stops at once')
    } finally { channel.restore() }
  }
  const down = fakeChannel({ throws: new Error('ECONNREFUSED https://channel.example.test sk-probe-secret') })
  try {
    const result = await probe()
    assert.deepEqual(result, { ok: false, reason: 'unreachable' })
  } finally { down.restore() }
})

test('a non-JSON success and a cancelled probe are reported, not thrown', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('<html>hello</html>', { status: 200 })
  try {
    assert.deepEqual(await probe(), { ok: false, reason: 'bad-response' })
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    assert.deepEqual(await probe({ signal: controller.signal }), { ok: false, reason: 'aborted' })
  } finally { globalThis.fetch = original }
  assert.deepEqual(await probeModel({ baseURL: 'not a url', model: 'm' }), { ok: false, reason: 'invalid-request' })
})

test('reasoning evidence is read from token counts and from reasoning text', () => {
  assert.equal(showsReasoning({ usage: { completion_tokens_details: { reasoning_tokens: 3 } } }), true)
  assert.equal(showsReasoning({ usage: { reasoning_tokens: 3 } }), true)
  assert.equal(showsReasoning({ choices: [{ message: { reasoning_content: 'hmm' } }] }), true)
  assert.equal(showsReasoning({ choices: [{ message: { reasoning: 'hmm' } }] }), true)
  assert.equal(showsReasoning({ choices: [{ message: { reasoning_details: [{ text: 'x' }] } }] }), true)
  assert.equal(showsReasoning({ usage: { completion_tokens_details: { reasoning_tokens: 0 } }, choices: [{ message: { reasoning_content: '  ' } }] }), false)
  assert.equal(showsReasoning({}), false)
  assert.equal(showsReasoning(null), false)
  assert.equal(completionsUrl('https://h.test/v1/'), 'https://h.test/v1/chat/completions')
  assert.equal(completionsUrl('https://h.test/v1/?k=1#frag'), 'https://h.test/v1/chat/completions?k=1')
})
