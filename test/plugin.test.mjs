/**
 * Host-side behaviour checks for `apply()`, driven by a fake Context.
 *
 * Run: node --test test/plugin.test.mjs
 * The fake models only what this plugin touches: `settings.describe`,
 * `settings.update`, `credentials.resolve`, `logger`, `get`, `on`, and `effect`.
 * Each test asserts one behaviour the profile write depends on.
 */

import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, DEFAULT_CONFIG } from '../index.js'
import { provenanceKey } from '../lib/provenance.js'

/** A controllable stand-in for the Host settings row this plugin writes. */
function createHarness(options = {}) {
  const state = {
    providers: options.providers ?? {
      'example-route': {
        displayName: 'Example Route',
        baseURL: 'https://gateway.test/v1',
        api: 'openai-responses',
        apiKeyEnv: 'TEST_API_KEY',
        models: [{ id: 'alpha' }, { id: 'beta', contextWindow: 1234 }],
      },
    },
    revision: 1,
    writes: [],
    described: 0,
  }
  const listeners = new Map()
  const cleanups = []
  const logs = []
  /** Mirrors HMR's transaction store, which refuses a nested write. */
  const executing = options.executing ?? new AsyncLocalStorage()
  const log = (level) => (...args) => {
    logs.push({ level, message: args.map((value) => String(value)).join(' ') })
  }
  const ctx = {
    logger: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    get: (name) => {
      if (name === 'llm') return options.llm
      if (name === 'loader') return options.loader
      if (name === 'connection' && options.routes !== undefined) {
        return { fetch: { register: (route) => { options.routes.set(route.path, route); return async () => {} } } }
      }
      if (name === 'hmr' && options.withHmr === true) return { executing }
      if (name === 'dshHomePath' && typeof options.homePath === 'string') {
        const root = options.homePath
        return (...segments) => [root, ...segments].join('\\')
      }
      return undefined
    },
    on: (event, handler) => {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
      return () => {}
    },
    effect: (register) => {
      const disposer = register()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return () => {}
    },
    credentials: {
      resolve: async (ref) =>
        ref === 'TEST_API_KEY' ? { value: 'sk-test', source: 'test' } : undefined,
    },
    settings: {
      describe: () => {
        state.described += 1
        const layer = state.providers
        return [
          {
            ns: options.settingsNs ?? 'llm-pi-ai',
            revision: state.revision,
            value: { providers: layer },
            base: { providers: layer },
            user: options.noUserLayer === true ? {} : { providers: layer },
            applies: 'live',
          },
        ]
      },
      update: async (ns, patch, revision) => {
        // The real config editor rejects a nested HMR transaction before it
        // touches the profile, so the harness reproduces that refusal.
        if (executing.getStore()) throw new Error('HMR transactions cannot be nested')
        state.writes.push({ ns, patch, revision })
        if (options.rejectWrite === true) throw new Error('revision conflict')
        // Mirror the real merge: plain objects merge, arrays replace.
        state.providers = mergeDeep(state.providers, patch.providers)
        state.revision += 1
      },
    },
  }
  return { ctx, state, logs, cleanups, listeners, executing }
}

/** Recursive object merge with array replacement, as `settings.update` does. */
function mergeDeep(under, over) {
  if (under === null || typeof under !== 'object' || Array.isArray(under)) return over
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) merged[key] = mergeDeep(under[key], value)
  return merged
}

/** A fetch stand-in that answers one fixed listing body. */
function stubFetch(body, options = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    if (options.error !== undefined) throw options.error
    if (options.status !== undefined) {
      return new Response(options.body ?? '', { status: options.status })
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const listing = {
  data: [
    {
      id: 'alpha',
      name: 'Alpha',
      context_length: 200000,
      max_output_tokens: 32000,
      architecture: { input_modalities: ['text', 'image'] },
      reasoning: { supported_efforts: ['none', 'low', 'medium', 'high'] },
    },
    {
      id: 'beta',
      context_length: 400000,
      supports_vision: false,
    },
  ],
}

/** Let the startup pass and its debounce settle. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

test('fills blank capabilities and keeps configured values', async () => {
  const stub = stubFetch(listing)
  const { ctx, state } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].url, 'https://gateway.test/v1/models')
  assert.equal(stub.calls[0].headers.get('authorization'), 'Bearer sk-test')

  const models = state.providers['example-route'].models
  assert.deepEqual(models[0], {
    id: 'alpha',
    contextWindow: 200000,
    maxTokens: 32000,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
  })
  // `beta` already declared a context window; only its missing fields are filled.
  assert.equal(models[1].contextWindow, 1234)
  assert.deepEqual(models[1].input, ['text'])
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].ns, 'llm-pi-ai')
})

test('dryRun reports the plan and writes nothing', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, logs } = createHarness()
  try {
    apply(ctx, { dryRun: true, startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 0)
  const dry = logs.find((entry) => entry.level === 'info' && entry.message.includes('dry run'))
  assert.ok(dry, 'the dry run reports its plan')
  assert.match(dry.message, /alpha/)
})

test('a profile with nothing left to fill makes no request', async () => {
  const stub = stubFetch(listing)
  const { ctx, state } = createHarness({
    providers: {
      'example-route': {
        baseURL: 'https://gateway.test/v1',
        models: [
          {
            id: 'alpha',
            contextWindow: 200000,
            maxTokens: 32000,
            input: ['text', 'image'],
            reasoningEfforts: { low: 'low' },
          },
        ],
      },
    },
  })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 0, 'no network call when every field is described')
  assert.equal(state.writes.length, 0)
})

test('overwrite replaces values the listing discloses', async () => {
  const stub = stubFetch(listing)
  const { ctx, state } = createHarness()
  try {
    apply(ctx, { overwrite: true, startupDelayMs: 0, debounceMs: 0 })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.providers['example-route'].models[1].contextWindow, 400000)
})

test('an unreachable endpoint logs a warning and leaves the profile alone', async () => {
  const stub = stubFetch(undefined, { error: new Error('connect ECONNREFUSED') })
  const { ctx, state, logs } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 0)
  const warning = logs.find((entry) => entry.level === 'warn')
  assert.ok(warning)
  assert.match(warning.message, /ECONNREFUSED/)
})

test('a rejected credential is reported as an HTTP status', async () => {
  const stub = stubFetch(undefined, { status: 401 })
  const { ctx, state, logs } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 0)
  assert.match(logs.find((entry) => entry.level === 'warn').message, /401.*API key/)
})

test('a stale revision is refused without throwing out of the pass', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, logs } = createHarness({ rejectWrite: true })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 1)
  assert.match(logs.find((entry) => entry.level === 'warn').message, /revision conflict/)
  assert.equal(logs.filter((entry) => entry.level === 'error').length, 0)
})

test('an inherited-only layer is left to the bundle that declares it', async () => {
  const stub = stubFetch(listing)
  const { ctx, state } = createHarness({ noUserLayer: true })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 0)
  assert.equal(state.writes.length, 0)
})

test('a saved provider profile triggers a pass', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, listeners } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 3600000, debounceMs: 0 })
    // The startup pass never runs; only the settings event can act.
    assert.equal(stub.calls.length, 0)
    for (const handler of listeners.get('settings/document-updated') ?? []) {
      handler('some-other-entry', 1)
    }
    await settle()
    assert.equal(stub.calls.length, 0, 'an unrelated namespace is ignored')
    for (const handler of listeners.get('settings/document-updated') ?? []) {
      handler('llm-pi-ai', 2)
    }
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 1)
  assert.equal(state.writes.length, 1)
})

test('enabled: false disables the automatic pass', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, listeners } = createHarness()
  try {
    apply(ctx, { enabled: false })
    for (const handler of listeners.get('settings/document-updated') ?? []) handler('llm-pi-ai', 2)
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 0)
  assert.equal(state.writes.length, 0)
})

test('settings saved through the Host route apply live, including re-enabling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-live-'))
  const stub = stubFetch(listing)
  const routes = new Map()
  const { ctx, state, listeners } = createHarness({ homePath: home, routes })
  const save = async (change) => {
    const route = routes.get('/api/model-capability-detector/settings')
    const read = await (await route.fetch(new Request('https://local.test/s'))).json()
    const response = await route.fetch(new Request('https://local.test/s', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-model-capability-detector': '1' },
      body: JSON.stringify({ revision: read.revision, ...change }),
    }))
    return { status: response.status, body: await response.json() }
  }
  const fire = async () => {
    for (const handler of listeners.get('settings/document-updated') ?? []) handler('llm-pi-ai', 2)
    await settle()
  }
  try {
    apply(ctx, { startupDelayMs: 3600000, debounceMs: 0, catalogFallback: false })
    assert.equal((await save({ set: { enabled: false } })).status, 200)
    await fire()
    assert.equal(stub.calls.length, 0, 'disabled from the GUI: no request')
    assert.equal((await save({ unset: ['enabled'] })).status, 200)
    await settle()
    assert.equal(stub.calls.length, 1, 'enabling again looks at the saved providers at once')
    assert.equal(state.writes.length, 1)
  } finally { stub.restore(); await rm(home, { recursive: true, force: true }) }
})

test('the echo of our own write does not schedule another request', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, listeners } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
    assert.equal(stub.calls.length, 1)
    // The settings service announces the write this plugin just made.
    for (const handler of listeners.get('settings/document-updated') ?? []) handler('llm-pi-ai', 3)
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(stub.calls.length, 1, 'writing our own result does not re-probe')
  assert.equal(state.writes.length, 1)
})

test('the documented defaults are the ones the row inherits', () => {
  assert.equal(DEFAULT_CONFIG.settingsNs, 'llm-pi-ai')
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.equal(DEFAULT_CONFIG.overwrite, false)
  assert.equal(DEFAULT_CONFIG.dryRun, false)
})

test('a pass started inside an HMR transaction still writes', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, logs, executing } = createHarness({ withHmr: true })
  try {
    // The Loader activates a plugin and publishes config reloads inside
    // `hmr.runExclusive`; the plugin must not inherit that scope for its write.
    await executing.run(true, async () => {
      apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
      await settle()
    })
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 1, 'the write is admitted outside the transaction')
  assert.equal(state.providers['example-route'].models[0].contextWindow, 200000)
  assert.equal(
    logs.filter((entry) => entry.level === 'warn').length,
    0,
    'no nested-transaction refusal is reported',
  )
})

test('a transaction-free profile writes without the HMR service', async () => {
  const stub = stubFetch(listing)
  const { ctx, state } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logging: true })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 1)
})


test('default logging is silent for successful and failed passes', async () => {
  assert.equal(DEFAULT_CONFIG.logging, false)
  assert.equal(DEFAULT_CONFIG.logFile, '')
  for (const options of [{}, { error: new Error('api_key=private') }]) {
    const { ctx, logs, cleanups } = createHarness()
    const stub = stubFetch(listing, options)
    try {
      apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
      await settle()
      assert.deepEqual(logs, [])
    } finally { cleanups.forEach((fn) => fn()); stub.restore() }
  }
})

test('fetch models collects reasoning metadata and reuses it on save without another listing request', async () => {
  const llm = { discoverModels: async () => { throw new Error('native custom request must be replaced') }, listConfigurableProviders: () => [] }
  const { ctx, state, listeners, cleanups } = createHarness({ llm })
  const stub = stubFetch(listing)
  try {
    apply(ctx, { startupDelayMs: 3600000, debounceMs: 0, catalogFallback: false })
    const models = await llm.discoverModels('llm-pi-ai', {
      provider: 'example-route', baseURL: 'https://gateway.test/v1', api: 'openai-responses',
    })
    assert.equal(stub.calls.length, 1)
    assert.equal(state.writes.length, 0, 'fetching a draft must not persist it')
    assert.equal(models[0].contextWindow, 200000)
    assert.deepEqual(models[0].inputModalities, ['text', 'image'])
    assert.equal(models[0].reasoningEfforts, undefined, 'core discovery schema does not carry reasoning')
    state.providers['example-route'].models = models.map(({ id, contextWindow, maxTokens, inputModalities }) => ({
      id, contextWindow, maxTokens, input: inputModalities,
    }))
    state.revision++
    for (const fn of listeners.get('settings/document-updated')) fn('llm-pi-ai', state.revision)
    await settle()
    assert.equal(stub.calls.length, 1, 'saved endpoint and credential match the discovery cache')
    assert.deepEqual(state.providers['example-route'].models[0].reasoningEfforts, {
      off: null, low: 'low', medium: 'medium', high: 'high',
    })
  } finally { cleanups.forEach((fn) => fn()); stub.restore() }
})

test('discoveryTrigger false leaves the native discovery method intact', () => {
  const original = async () => []
  const llm = { discoverModels: original, listConfigurableProviders: () => [] }
  const { ctx, cleanups } = createHarness({ llm })
  apply(ctx, { discoveryTrigger: false })
  assert.equal(llm.discoverModels, original)
  cleanups.forEach((fn) => fn())
})

test('unloading during a pending listing aborts the request and prevents writes', async () => {
  let finish
  let requestSignal
  const original = globalThis.fetch
  const { ctx, state, cleanups } = createHarness()
  globalThis.fetch = async (_url, init) => {
    requestSignal = init.signal
    return new Promise((resolve) => { finish = () => resolve(new Response(JSON.stringify(listing))) })
  }
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
    await settle()
    assert.equal(typeof finish, 'function')
    cleanups.forEach((fn) => fn())
    assert.equal(requestSignal.aborted, true)
    finish()
    await settle()
    assert.equal(state.writes.length, 0)
  } finally { globalThis.fetch = original }
})

test('unloading before loader settlement prevents a late startup pass', async () => {
  let finish
  const loader = { await: () => new Promise((resolve) => { finish = resolve }) }
  const { ctx, state, cleanups } = createHarness({ loader })
  const stub = stubFetch(listing)
  try {
    apply(ctx, { startupDelayMs: 0 })
    cleanups.forEach((fn) => fn())
    finish()
    await settle()
    assert.equal(stub.calls.length, 0)
    assert.equal(state.writes.length, 0)
  } finally { stub.restore() }
})

test('a concurrent user edit is reread before writing model arrays', async () => {
  const { ctx, state, cleanups } = createHarness()
  const original = globalThis.fetch
  let release
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) await new Promise((resolve) => { release = resolve })
    return new Response(JSON.stringify(listing))
  }
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogFallback: false })
    await settle()
    state.providers['example-route'].models[0].contextWindow = 999
    state.revision++
    release()
    await settle()
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].revision, 2)
    assert.equal(state.providers['example-route'].models[0].contextWindow, 999)
  } finally { cleanups.forEach((fn) => fn()); globalThis.fetch = original }
})

test('an explicitly configured missing credential is not sent as an unauthenticated probe', async () => {
  const { ctx, state, cleanups } = createHarness()
  ctx.credentials.resolve = async () => undefined
  const stub = stubFetch(listing)
  try {
    apply(ctx, { startupDelayMs: 0, catalogFallback: false })
    await settle()
    assert.equal(stub.calls.length, 0)
    assert.equal(state.writes.length, 0)
  } finally { cleanups.forEach((fn) => fn()); stub.restore() }
})


test('editing an endpoint does not forward saved credentials or headers to the new endpoint', async () => {
  const llm = { discoverModels: async () => [], listConfigurableProviders: () => [] }
  const { ctx, state, cleanups } = createHarness({ llm })
  state.providers['example-route'].headers = { Authorization: 'Bearer saved-secret', 'x-tenant-secret': 'private' }
  let resolved = 0
  ctx.credentials.resolve = async () => { resolved++; return { value: 'saved-key' } }
  const stub = stubFetch(listing)
  try {
    apply(ctx, { startupDelayMs: 3600000, catalogFallback: false })
    await llm.discoverModels('llm-pi-ai', { provider: 'example-route', baseURL: 'https://different.test/v1', api: 'openai-responses' })
    assert.equal(resolved, 0)
    assert.equal(stub.calls[0].headers.has('authorization'), false)
    assert.equal(stub.calls[0].headers.has('x-tenant-secret'), false)
    await llm.discoverModels('llm-pi-ai', { provider: 'example-route', baseURL: 'https://gateway.test/v1', api: 'openai-responses', apiKey: 'typed-key' })
    assert.equal(stub.calls[1].headers.get('authorization'), 'Bearer typed-key')
    assert.equal(resolved, 0)
    assert.equal(state.providers['example-route'].headers.Authorization, 'Bearer saved-secret')
  } finally { cleanups.forEach((fn) => fn()); stub.restore() }
})


test('an explicit model refresh invalidates a previously inspected unchanged configuration', async () => {
  const llm = { discoverModels: async () => [], listConfigurableProviders: () => [] }
  const { ctx, state, listeners, cleanups } = createHarness({ llm })
  const original = globalThis.fetch
  let discloseReasoning = false
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
    id: 'alpha', context_length: 200000, max_output_tokens: 32000, input: ['text'],
    ...(discloseReasoning ? { reasoning_efforts: ['low', 'high'] } : {}),
  }] }))
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogFallback: false })
    await settle()
    assert.equal(state.writes.length, 1)
    discloseReasoning = true
    await llm.discoverModels('llm-pi-ai', { provider: 'example-route', baseURL: 'https://gateway.test/v1', api: 'openai-responses' })
    assert.equal(state.writes.length, 1, 'discovery only updates its in-memory metadata')
    state.revision++
    for (const fn of listeners.get('settings/document-updated')) fn('llm-pi-ai', state.revision)
    await settle()
    assert.equal(state.writes.length, 2)
    assert.deepEqual(state.providers['example-route'].models[0].reasoningEfforts, { low: 'low', high: 'high' })
  } finally { cleanups.forEach((fn) => fn()); globalThis.fetch = original }
})

const DETECTOR = '/api/model-capability-detector/detector'
const call = (routes, input) => {
  const route = routes.get(DETECTOR)
  return route.fetch(new Request('https://local.test/d', input === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-model-capability-detector': '1' }, body: JSON.stringify(input),
  }))
}

test('the detection report names source and reason per field and never exposes the endpoint', async () => {
  const routes = new Map()
  const { ctx } = createHarness({ routes })
  apply(ctx, { startupDelayMs: 3600000, catalogFallback: false })
  const response = await call(routes)
  const text = await response.text()
  assert.equal(text.includes('gateway.test'), false, 'no address in the report')
  assert.equal(text.includes('TEST_API_KEY'), false)
  const report = JSON.parse(text)
  assert.equal(report.ok, true)
  const models = report.routes[0].models
  assert.deepEqual(models[0].fields.contextWindow, { state: 'empty', reason: 'catalog-disabled' })
  assert.deepEqual(models[1].fields.contextWindow, { state: 'set', value: 1234, tier: 'manual' })
})

test('look-up resolves a pinned model, honours aliases and rejects bad input', async () => {
  const routes = new Map()
  const { ctx } = createHarness({ routes })
  apply(ctx, { startupDelayMs: 3600000, catalogFallback: false, modelAliases: { 'my-gw': 'deepseek-v4.1-flash-1017' } })
  const pinned = await (await call(routes, { action: 'lookup', model: 'deepseek-v4.1-flash-1017' })).json()
  assert.equal(pinned.status, 'resolved')
  assert.equal(pinned.fields.contextWindow.value, 1048576)
  assert.equal(pinned.fields.contextWindow.tier, 'official')
  const aliased = await (await call(routes, { action: 'lookup', model: 'my-gw' })).json()
  assert.equal(aliased.aliased, true)
  assert.equal(aliased.fields.maxTokens.value, 393216)
  const missing = await (await call(routes, { action: 'lookup', model: 'no-such-model' })).json()
  assert.equal(missing.fields.contextWindow.state, 'empty')
  assert.equal((await call(routes, { action: 'lookup', model: '' })).status, 400)
  assert.equal((await call(routes, { action: 'nope' })).status, 400)
})

test('rescan runs a pass on demand and reports a disabled plugin', async () => {
  const stub = stubFetch(listing)
  const routes = new Map()
  const { ctx, state } = createHarness({ routes })
  try {
    apply(ctx, { startupDelayMs: 3600000, debounceMs: 0, catalogFallback: false })
    assert.equal((await (await call(routes, { action: 'rescan' })).json()).ok, true)
    assert.equal(state.writes.length, 1)
    await call(routes, { action: 'rescan' })
    assert.equal(state.writes.length, 1, 'a second pass with nothing new writes nothing')
  } finally { stub.restore() }
  const disabled = new Map()
  apply(createHarness({ routes: disabled }).ctx, { enabled: false })
  assert.deepEqual(await (await call(disabled, { action: 'rescan' })).json(), { ok: false, reason: 'disabled' })
})

test('a value the plugin wrote from a weak source is upgraded; one you typed is not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-upgrade-'))
  const stub = stubFetch(listing)
  const receipt = (value) => ({ value, source: { kind: 'api-hint' }, at: new Date().toISOString() })
  try {
    await mkdir(join(home, 'cache', 'model-capability-detector'), { recursive: true })
    await writeFile(join(home, 'cache', 'model-capability-detector', 'provenance.json'), JSON.stringify({
      version: 1, receipts: { [provenanceKey('example-route', 'alpha', 'contextWindow')]: receipt(1000) },
    }))
    const providers = { 'example-route': { baseURL: 'https://gateway.test/v1', api: 'openai-responses', apiKeyEnv: 'TEST_API_KEY', models: [
      { id: 'alpha', contextWindow: 1000 }, // written by the plugin earlier
      { id: 'beta', contextWindow: 1000 }, // typed by the user: no receipt
    ] } }
    const { ctx, state } = createHarness({ homePath: home, providers })
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogFallback: false })
    await settle()
    const [alpha, beta] = state.providers['example-route'].models
    assert.equal(alpha.contextWindow, 200000, 'channel API replaces the weaker hint-based value')
    assert.equal(beta.contextWindow, 1000, 'a hand-typed value is left alone')
  } finally { stub.restore(); await rm(home, { recursive: true, force: true }) }
})

test('turning upgrades off leaves earlier values alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-noupgrade-'))
  const stub = stubFetch(listing)
  try {
    await mkdir(join(home, 'cache', 'model-capability-detector'), { recursive: true })
    await writeFile(join(home, 'cache', 'model-capability-detector', 'provenance.json'), JSON.stringify({
      version: 1, receipts: { [provenanceKey('example-route', 'alpha', 'contextWindow')]: { value: 1000, source: { kind: 'api-hint' }, at: new Date().toISOString() } },
    }))
    const providers = { 'example-route': { baseURL: 'https://gateway.test/v1', api: 'openai-responses', apiKeyEnv: 'TEST_API_KEY', models: [{ id: 'alpha', contextWindow: 1000 }] } }
    const { ctx, state } = createHarness({ homePath: home, providers })
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogFallback: false, upgradeWritten: false })
    await settle()
    assert.equal(state.providers['example-route'].models[0].contextWindow, 1000)
  } finally { stub.restore(); await rm(home, { recursive: true, force: true }) }
})