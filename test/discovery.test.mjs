import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeDiscovery, createDiscoveryCache, waitWithSignal } from '../lib/discovery.js'
import { readJsonResponse } from '../lib/http.js'

function context(llm) {
  const cleanups = []
  return { cleanups, get: () => llm, effect: (fn) => { cleanups.push(fn()) } }
}

test('custom discovery returns candidate metadata and restores the public method on unload', async () => {
  let delegated = 0
  const original = async () => { delegated++; return [{ id: 'native' }] }
  const llm = { discoverModels: original, listConfigurableProviders: () => [{ provider: 'native', settingsNs: 'llm-pi-ai', declared: false }] }
  const ctx = context(llm)
  let probes = 0
  bridgeDiscovery(ctx, { settingsNs: 'llm-pi-ai', discover: async () => {
    probes++
    return [{ id: 'alpha', contextWindow: 128000, maxTokens: 8000, input: ['text', 'image'], reasoningEfforts: { high: 'high' } }]
  }, onError: () => {} })
  assert.deepEqual(await llm.discoverModels('llm-pi-ai', { baseURL: 'https://gateway.test/v1' }), [
    { id: 'alpha', contextWindow: 128000, maxTokens: 8000, inputModalities: ['text', 'image'] },
  ])
  await llm.discoverModels('other', { baseURL: 'https://gateway.test/v1' })
  await llm.discoverModels('llm-pi-ai', { provider: 'native', baseURL: 'https://gateway.test/v1' })
  assert.equal(probes, 1)
  assert.equal(delegated, 2)
  ctx.cleanups.forEach((fn) => fn())
  assert.equal(llm.discoverModels, original)
})

test('a wrapper retained by another plugin becomes a pass-through on unload', async () => {
  const llm = { discoverModels: async () => [{ id: 'native' }], listConfigurableProviders: () => [] }
  const ctx = context(llm)
  bridgeDiscovery(ctx, { settingsNs: 'llm-pi-ai', discover: async () => [{ id: 'custom' }], onError: () => {} })
  const retained = llm.discoverModels
  llm.discoverModels = (...args) => retained(...args)
  const later = llm.discoverModels
  ctx.cleanups.forEach((fn) => fn())
  assert.equal(llm.discoverModels, later)
  assert.deepEqual(await later('llm-pi-ai', { baseURL: 'https://gateway.test/v1' }), [{ id: 'native' }])
})

test('discovery cache separates endpoints, protocols, credentials and headers without retaining raw credentials', () => {
  const cache = createDiscoveryCache()
  const target = { baseURL: 'https://gateway.test/v1', api: 'openai-responses', apiKey: 'test-secret', headers: { tenant: 'a' } }
  cache.put(target, [{ id: 'alpha', contextWindow: 64000 }])
  for (const change of [{ apiKey: 'different' }, { baseURL: 'https://other.test' }, { api: 'anthropic-messages' }, { headers: { tenant: 'b' } }]) {
    assert.equal(cache.get({ ...target, ...change }), undefined)
  }
  const first = cache.get(target)
  first[0].contextWindow = 1
  assert.equal(cache.get(target)[0].contextWindow, 64000)
  cache.clear()
  assert.equal(cache.get(target), undefined)
})

test('discovery failures return a safe message without retrying the original request', async () => {
  const llm = { discoverModels: async () => { throw new Error('must not retry') }, listConfigurableProviders: () => [] }
  const ctx = context(llm)
  bridgeDiscovery(ctx, { settingsNs: 'llm-pi-ai', discover: async () => { throw new Error('api_key=private') }, onError: () => {} })
  await assert.rejects(llm.discoverModels('llm-pi-ai', { baseURL: 'https://gateway.test/v1' }), (error) => {
    assert.doesNotMatch(error.message, /private/)
    return true
  })
  ctx.cleanups.forEach((fn) => fn())
})

test('bounded reader counts UTF-8 bytes and cancels a streaming body on overflow', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('"中文中文"')) },
    cancel() { cancelled = true },
  }))
  await assert.rejects(readJsonResponse(response, 8), /exceeds/)
  assert.equal(cancelled, true)
})

test('bounded reader rejects excessive declared lengths and invalid JSON', async () => {
  await assert.rejects(readJsonResponse(new Response('{}', { headers: { 'content-length': '100' } }), 10), /declares/)
  await assert.rejects(readJsonResponse(new Response('invalid'), 100), /JSON/)
  assert.deepEqual(await readJsonResponse(new Response('{"data":[]}'), 100), { data: [] })
})


test('bridge restores inherited methods behind a Cordis-style tracing proxy', async () => {
  class Llm {
    async discoverModels() { return [{ id: this.caller }] }
    listConfigurableProviders() { return [] }
  }
  const target = new Llm()
  target.caller = 'native-context'
  const llm = new Proxy(target, { get(object, key, receiver) {
    const value = Reflect.get(object, key, receiver)
    return typeof value === 'function' ? new Proxy(value, { apply(fn, thisArg, args) {
      return Reflect.apply(fn, thisArg, args)
    } }) : value
  } })
  const ctx = context(llm)
  bridgeDiscovery(ctx, { settingsNs: 'llm-pi-ai', discover: async () => [{ id: 'custom' }], onError: () => {} })
  assert.deepEqual(await llm.discoverModels('other', {}), [{ id: 'native-context' }])
  assert.deepEqual(await llm.discoverModels('llm-pi-ai', { baseURL: 'https://gateway.test/v1' }), [{ id: 'custom' }])
  assert.equal(Object.hasOwn(target, 'discoverModels'), true)
  ctx.cleanups.forEach((fn) => fn())
  assert.equal(Object.hasOwn(target, 'discoverModels'), false)
  assert.deepEqual(await llm.discoverModels('llm-pi-ai', {}), [{ id: 'native-context' }])
})

test('caller cancellation stops waiting for shared catalog work immediately', async () => {
  let finish
  const operation = new Promise((resolve) => { finish = resolve })
  const controller = new AbortController()
  const result = waitWithSignal(operation, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(result, /cancelled/)
  finish('catalog can be reused')
  assert.equal(await operation, 'catalog can be reused')
})
