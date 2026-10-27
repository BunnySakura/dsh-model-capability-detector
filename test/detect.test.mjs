/**
 * Workspace checks for the pure detection helpers.
 *
 * Run: node test/detect.test.mjs
 * These assert the documented listing shapes (OpenAI, OpenRouter, vLLM,
 * LiteLLM, Anthropic) produce the capabilities they disclose and decline to
 * guess the ones they withhold.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  capabilitiesOf,
  configured,
  detectInput,
  detectReasoning,
  effortsFromLevels,
  listingHeaders,
  listingUrl,
  normalizeLevel,
  normalizeLevels,
  readListing,
} from '../lib/detect.js'
import { describeChanges, mergeDetected, sameProviders } from '../lib/plan.js'

test('listing URLs follow each protocol', () => {
  assert.deepEqual(listingUrl('https://api.example/v1', 'openai-completions'), {
    url: 'https://api.example/v1/models',
    family: 'openai',
  })
  assert.deepEqual(listingUrl('https://api.example/v1/', 'openai-responses'), {
    url: 'https://api.example/v1/models',
    family: 'openai',
  })
  assert.deepEqual(listingUrl('https://api.anthropic.com/v1', 'anthropic-messages'), {
    url: 'https://api.anthropic.com/v1/models?limit=1000',
    family: 'anthropic',
  })
  assert.deepEqual(listingUrl('https://gw.example/anthropic', 'anthropic-messages'), {
    url: 'https://gw.example/anthropic/v1/models?limit=1000',
    family: 'anthropic',
  })
})

test('headers carry the credential the protocol expects', () => {
  const openai = listingHeaders('openai', 'sk-test')
  assert.equal(openai.get('authorization'), 'Bearer sk-test')
  assert.equal(openai.get('accept'), 'application/json')

  const anthropic = listingHeaders('anthropic', 'sk-ant')
  assert.equal(anthropic.get('x-api-key'), 'sk-ant')
  assert.equal(anthropic.get('anthropic-version'), '2023-06-01')
  assert.equal(anthropic.get('authorization'), null)

  // A configured header wins over the api key, and no key means no auth header.
  const custom = listingHeaders('openai', 'sk-test', { authorization: 'Bearer explicit' })
  assert.equal(custom.get('authorization'), 'Bearer explicit')
  assert.equal(listingHeaders('openai', undefined).get('authorization'), null)
})

test('level names normalize across vendor spellings', () => {
  assert.equal(normalizeLevel('none'), 'off')
  assert.equal(normalizeLevel('Extra High'), 'xhigh')
  assert.equal(normalizeLevel('MID'), 'medium')
  assert.equal(normalizeLevel('ultra'), 'max')
  assert.equal(normalizeLevel('banana'), undefined)
  assert.deepEqual([...normalizeLevels(['low', 'high', 'none'])], ['off', 'low', 'high'])
  assert.deepEqual([...normalizeLevels({ enum: ['medium', 'max'] })], ['medium', 'max'])
  assert.deepEqual([...normalizeLevels({ low: true, high: true, max: false })], ['low', 'high'])
  assert.equal(normalizeLevels([]), undefined)
})

test('efforts dict follows pi-ai escalation order and drops off-only models', () => {
  const efforts = effortsFromLevels(new Set(['high', 'off', 'low']))
  assert.deepEqual(efforts, { off: null, low: 'low', high: 'high' })
  assert.equal(effortsFromLevels(new Set(['off'])), undefined)
})

test('image input is read from modality lists, flags, and the modality string', () => {
  assert.deepEqual(detectInput({ architecture: { input_modalities: ['text', 'image', 'file'] } }), [
    'text',
    'image',
  ])
  assert.deepEqual(detectInput({ architecture: { modality: 'text+image->text' } }), ['text', 'image'])
  assert.deepEqual(detectInput({ input: ['text'] }), ['text'])
  assert.deepEqual(detectInput({ capabilities: { vision: true } }), ['text', 'image'])
  assert.deepEqual(detectInput({ capabilities: { vision: false } }), ['text'])
  assert.deepEqual(detectInput({ architecture: { modality: 'text->text' } }), ['text'])
  assert.equal(detectInput({}), undefined)
})

test('reasoning detection prefers disclosed levels over booleans', () => {
  assert.deepEqual(detectReasoning({ reasoning: { supported_efforts: ['none', 'low', 'high'] } }), {
    off: null,
    low: 'low',
    high: 'high',
  })
  assert.equal(detectReasoning({ reasoning: false }), false)
  assert.equal(detectReasoning({ supports_reasoning: false }), false)
  assert.equal(detectReasoning({}), undefined)
  // A non-reasoning disclosure must not be reported as an efforts dict.
  assert.equal(detectReasoning({ reasoning: { supported_efforts: ['none'] } }), undefined)
})

test('OpenRouter-shaped entries yield every disclosed capability', () => {
  const entry = {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Anthropic: Claude Haiku 5.5',
    context_length: 1000000,
    architecture: { modality: 'text+image+file->text', input_modalities: ['text', 'image', 'file'] },
    top_provider: { context_length: 1000000, max_completion_tokens: 128000 },
    reasoning: { mandatory: false, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'] },
  }
  assert.deepEqual(capabilitiesOf(entry), {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Anthropic: Claude Haiku 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  })
})

test('vLLM and LiteLLM spellings resolve to the same capabilities', () => {
  const vllm = capabilitiesOf({
    id: 'Qwen/Qwen3-32B',
    max_model_len: 40960,
    input_modalities: ['text'],
  })
  assert.equal(vllm.contextWindow, 40960)
  assert.deepEqual(vllm.input, ['text'])
  assert.equal(vllm.reasoningEfforts, undefined)

  const litellm = capabilitiesOf({
    id: 'gpt-5',
    context_window: 400000,
    max_output_tokens: 128000,
    supports_vision: false,
  })
  assert.equal(litellm.contextWindow, 400000)
  assert.equal(litellm.maxTokens, 128000)
  assert.deepEqual(litellm.input, ['text'])
})

test('a sparse listing entry discloses nothing it does not carry', () => {
  const sparse = capabilitiesOf({ id: 'mystery-model' })
  assert.deepEqual(sparse, { id: 'mystery-model' })
  assert.equal(sparse.contextWindow, undefined)
  assert.equal(sparse.input, undefined)
  assert.equal(sparse.reasoningEfforts, undefined)
})

test('listings are read from both published envelope shapes', () => {
  const fromData = readListing({ data: [{ id: 'a', context_length: 1000 }, { id: 'b' }] })
  assert.deepEqual(fromData.map((entry) => entry.id), ['a', 'b'])
  assert.equal(fromData[0].contextWindow, 1000)

  const fromMap = readListing({ models: { alias: { id: 'real-id' }, second: { context_window: 2000 } } })
  assert.deepEqual(fromMap, [{ id: 'real-id' }, { id: 'second', contextWindow: 2000 }])

  // Dedupe keeps endpoint order.
  assert.deepEqual(readListing({ data: [{ id: 'a' }, { id: 'a' }] }).map((e) => e.id), ['a'])

  assert.throws(() => readListing({ nope: 1 }), /data.*array.*models.*object/)
})

test('configured() distinguishes blanks from real values', () => {
  assert.equal(configured(undefined), false)
  assert.equal(configured(''), false)
  assert.equal(configured([]), false)
  assert.equal(configured({}), false)
  assert.equal(configured(null), false)
  assert.equal(configured(0), false)
  assert.equal(configured(200000), true)
  assert.equal(configured(['text', 'image']), true)
  // `false` is the pi-ai spelling of "not a reasoning model" — a real answer.
  assert.equal(configured(false), true)
})

const providers = {
  'example-route': {
    displayName: 'Example Route',
    baseURL: 'https://gateway.example/v1',
    api: 'openai-responses',
    models: [
      { id: 'example-large', name: 'example-large' },
      { id: 'example-small', contextWindow: 1000000, input: ['text'] },
      { id: 'untouched' },
    ],
  },
  'no-models': { displayName: 'Empty' },
}

const detected = new Map([
  [
    'example-route',
    new Map([
      ['example-large', { id: 'example-large', contextWindow: 1000000, input: ['text', 'image'] }],
      ['example-small', { id: 'example-small', contextWindow: 2000000, input: ['text', 'image'], maxTokens: 128000 }],
    ]),
  ],
])

test('merge fills blanks and leaves configured values alone', () => {
  const { providers: next, changes } = mergeDetected(providers, detected, false)
  const models = next['example-route'].models
  assert.equal(models[0].contextWindow, 1000000)
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.deepEqual(models[1].input, ['text'], 'a configured modality list is kept')
  assert.equal(models[1].contextWindow, 1000000, 'a configured context window is kept')
  assert.equal(models[1].maxTokens, 128000, 'an unset field is still filled')
  assert.deepEqual(models[2], { id: 'untouched' })
  assert.deepEqual(next['no-models'], providers['no-models'])
  assert.deepEqual(describeChanges(changes), [
    'example-route/example-large: contextWindow=1000000, input=["text","image"]',
    'example-route/example-small: maxTokens=128000',
  ])
})

test('overwrite replaces disclosed values', () => {
  const { providers: next } = mergeDetected(providers, detected, true)
  assert.equal(next['example-route'].models[1].contextWindow, 2000000)
  assert.deepEqual(next['example-route'].models[1].input, ['text', 'image'])
})

test('merge reports no change when nothing is fillable, and never mutates its input', () => {
  const snapshot = JSON.stringify(providers)
  const empty = mergeDetected(providers, new Map(), false)
  assert.equal(empty.changes.length, 0)
  assert.ok(sameProviders(empty.providers, providers))
  const again = mergeDetected(providers, detected, false)
  const twice = mergeDetected(again.providers, detected, false)
  assert.equal(twice.changes.length, 0, 'a second pass finds nothing left to fill')
  assert.equal(JSON.stringify(providers), snapshot)
})

test('a route missing from the listing is skipped, not emptied', () => {
  const { providers: next, changes } = mergeDetected(
    { route: { models: [{ id: 'a', contextWindow: 500 }] } },
    new Map([['route', new Map()]]),
    true,
  )
  assert.deepEqual(next.route.models, [{ id: 'a', contextWindow: 500 }])
  assert.equal(changes.length, 0)
})
