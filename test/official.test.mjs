import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIndex, resolveName, toLookup } from '../lib/catalog.js'
import { DEFAULT_CONFIG } from '../index.js'
import { VERIFIED } from '../lib/official.js'

const model = (context, extra = {}) => ({ id: 'deepseek-flash', canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017', limit: { context, output: 393216 }, modalities: { input: ['text', 'image'] }, ...extra })
const document = (original = model(1048576)) => ({
  deepseek: { id: 'deepseek', doc: 'https://api-docs.deepseek.com/quick_start/pricing', models: { 'deepseek-flash': original } },
  reseller: { id: 'reseller', doc: 'https://reseller.test/docs', models: { 'deepseek-flash': model(128000) } },
})
const lookup = (doc) => toLookup(JSON.parse(JSON.stringify(buildIndex(doc))))

test('default uses the original-provider record rather than a reseller minimum', () => {
  assert.equal(DEFAULT_CONFIG.catalogNumericStrategy, 'official')
  const answer = resolveName(lookup(document()), 'deepseek-flash')
  assert.equal(answer.safe.contextWindow, 1048576)
  assert.equal(answer.sources.contextWindow.kind, 'original-provider-mirror')
  assert.equal(answer.sources.contextWindow.channelVerified, false)
  assert.deepEqual(answer.sources.contextWindow.urls, ['https://api-docs.deepseek.com/quick_start/pricing'])
  assert.equal(resolveName(lookup(document()), 'deepseek-flash', { numericStrategy: 'minimum' }).safe.contextWindow, 128000)
})

test('matches original canonical ids and preserves dated and punctuation variants', () => {
  const source = lookup(document())
  assert.equal(resolveName(source, 'deepseek/deepseek-v4.1-flash-1017').safe.contextWindow, 1048576)
  assert.equal(resolveName(source, 'gateway/deepseek-v4.1-flash-1017').safe.contextWindow, 1048576)
  // Different snapshots or products never borrow this record.
  for (const id of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-0423', 'dsv4.1flash']) {
    assert.equal(resolveName(source, id).status, 'unknown', id)
  }
  // A difference in separators only is the same model, reported as a family match.
  const spaced = resolveName(source, 'deepseek_v4_1_flash_1017')
  assert.equal(spaced.status, 'resolved')
  assert.equal(spaced.match, 'family')
  assert.equal(spaced.safe.contextWindow, 1048576)
})

test('unknown or forged publisher cannot supply original-provider fallback', () => {
  for (const doc of ['https://api-docs.deepseek.com.evil.test/pricing', 'http://api-docs.deepseek.com/pricing', 'https://user:pass@api-docs.deepseek.com/pricing']) {
    const input = document()
    input.deepseek.doc = doc
    assert.equal(resolveName(lookup(input), 'deepseek-flash').status, 'unknown')
  }
  const input = document()
  delete input.deepseek
  assert.equal(resolveName(lookup(input), 'deepseek-flash').status, 'unknown')
})

test('conflicting original aliases withhold the affected field, without minimum or maximum guessing', () => {
  const input = document()
  input.deepseek.models.alias = model(200000)
  for (const entry of Object.values(input.deepseek.models)) entry.canonical_model_id = 'deepseek/synthetic-snapshot'
  const answer = resolveName(lookup(input), 'deepseek/synthetic-snapshot')
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.safe.contextWindow, undefined)
  assert.deepEqual(answer.withheld.contextWindow, [1048576, 200000])
  assert.equal(answer.safe.maxTokens, 393216)
})

test('explicitly hosted foreign model is not an original-provider record', () => {
  const input = document(model(200000, { canonical_model_id: 'other/model' }))
  assert.equal(resolveName(lookup(input), 'deepseek-flash').status, 'unknown')
})

test('original effort list and explicit toggle preserve off without inventing other efforts', () => {
  const input = document(model(1048576, { reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }] }))
  assert.deepEqual(resolveName(lookup(input), 'deepseek-flash').safe.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })
})

test('every pinned record carries its sources, a date, and a vendor-owned documentation host', () => {
  assert.ok(VERIFIED.length >= 1, 'data/verified.json loads')
  for (const row of VERIFIED) {
    const label = row.id
    assert.match(row.updated ?? '', /^\d{4}-\d{2}-\d{2}$/, `${label}: verification date`)
    assert.ok(row.canonical?.startsWith(`${row.vendor}/`), `${label}: canonical id names its own vendor`)
    // Release page plus a pinned configuration and the API reference: three independent sources.
    const links = [row.doc, ...(row.urls ?? [])]
    assert.ok(links.length >= 3 && new Set(links).size === links.length, `${label}: three distinct sources`)
    for (const link of links) {
      const url = new URL(link)
      assert.equal(url.protocol, 'https:', `${label}: https only`)
      assert.equal(url.username + url.password, '', `${label}: no credentials in a link`)
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      assert.ok(Number.isSafeInteger(row.safe[field]) && row.safe[field] > 0, `${label}: ${field}`)
    }
    assert.ok(row.safe.maxTokens <= row.safe.contextWindow, `${label}: output cannot exceed the context window`)
    assert.ok(Array.isArray(row.safe.input) && row.safe.input.includes('text'), `${label}: input modalities`)
    assert.equal(row.direct, true)
  }
})