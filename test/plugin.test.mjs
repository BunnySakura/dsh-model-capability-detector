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
import { test } from 'node:test'

import { apply, DEFAULT_CONFIG } from '../index.js'

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
    get: (name) => (name === 'hmr' && options.withHmr === true ? { executing } : undefined),
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { dryRun: true, startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
  assert.equal(listeners.size, 0, 'no listeners are installed when disabled')
  assert.equal(state.writes.length, 0)
})

test('the echo of our own write does not schedule another request', async () => {
  const stub = stubFetch(listing)
  const { ctx, state, listeners } = createHarness()
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
      apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
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
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
    await settle()
  } finally {
    stub.restore()
  }
  assert.equal(state.writes.length, 1)
})
