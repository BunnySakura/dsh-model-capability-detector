/**
 * Fallback behaviour in the real pass, driven by the same fake Context.
 *
 * Run: node --test test/fallback.test.mjs
 * These assert the contract that matters: the endpoint wins, the catalog fills
 * only what it is allowed to, and a contradicted value is never written.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

/** Merge plain objects recursively with array replacement, as settings does. */
function mergeDeep(under, over) {
  if (under === null || typeof under !== 'object' || Array.isArray(under)) return over
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) merged[key] = mergeDeep(under[key], value)
  return merged
}

/** A Context stand-in with a temp home and no HMR service. */
function harness(options) {
  const state = { providers: options.providers, revision: 1, writes: [] }
  const logs = []
  const log = (level) => (...args) =>
    logs.push({ level, message: args.map(String).join(' ') })
  const ctx = {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    get: (name) => {
      if (name === 'dshHomePath') return (...segments) => join(options.homePath, ...segments)
      return undefined
    },
    on: () => () => {},
    effect: (register) => {
      register()
      return () => {}
    },
    credentials: { resolve: async () => undefined },
    settings: {
      describe: () => [
        {
          ns: 'llm-pi-ai',
          revision: state.revision,
          value: { providers: state.providers },
          base: { providers: state.providers },
          user: { providers: state.providers },
          applies: 'live',
        },
      ],
      update: async (ns, patch, revision) => {
        state.writes.push({ ns, patch, revision })
        state.providers = mergeDeep(state.providers, patch.providers)
        state.revision += 1
      },
    },
  }
  return { ctx, state, logs }
}

/** The endpoint answers with ids only, which is the case the fallback exists for. */
const bareListing = { data: [{ id: 'alpha', object: 'model' }, { id: 'beta', object: 'model' }] }

/** A catalog where the two vendors agree on modalities but not on context. */
const catalog = {
  vendor: {
    id: 'vendor',
    models: {
      alpha: {
        id: 'alpha',
        limit: { context: 200000, output: 32000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      beta: {
        id: 'beta',
        limit: { context: 400000, output: 8000 },
        modalities: { input: ['text'] },
        reasoning: false,
      },
    },
  },
  reseller: {
    id: 'reseller',
    models: {
      alpha: {
        id: 'alpha',
        limit: { context: 999999, output: 32000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
}

/** Swap `fetch` for the duration of one test. */
function stubFetch(routes) {
  const calls = []
  const original = globalThis.fetch
  // Longest key first: the catalog URL contains "/models" too, so a plain
  // first-match would hand the catalog request to the listing route.
  const ordered = Object.keys(routes).sort((left, right) => right.length - left.length)
  globalThis.fetch = async (url) => {
    const text = String(url)
    calls.push(text)
    const route = ordered.find((key) => text.includes(key))
    if (route === undefined) return new Response('', { status: 404 })
    const answer = routes[route]
    if (answer === 'fail') return new Response('', { status: 500 })
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Wait for the startup pass and its catalog load. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120))

/** A profile with one route whose models carry no capabilities. */
function blankProfile() {
  return {
    'example-route': {
      displayName: 'Example',
      baseURL: 'https://gateway.test/v1',
      api: 'openai-responses',
      models: [{ id: 'alpha' }, { id: 'beta' }],
    },
  }
}

test('the catalog fills safe fields the endpoint left empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const { ctx, state } = harness({ providers: blankProfile(), homePath: home })
  const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
    await settle()
  } finally {
    stub.restore()
    await rm(home, { recursive: true, force: true })
  }

  const [alpha, beta] = state.providers['example-route'].models
  // Modalities agreed across both vendors, so they are written.
  assert.deepEqual(alpha.input, ['text', 'image'])
  assert.deepEqual(alpha.reasoningEfforts, { low: 'low', high: 'high' })
  // The two vendors disagreed on context, so nothing is written for it.
  assert.equal(alpha.contextWindow, undefined, 'a contradicted value is withheld')
  assert.equal(alpha.maxTokens, undefined, 'numbers need the explicit opt-in')

  assert.deepEqual(beta.input, ['text'])
  assert.equal(beta.reasoningEfforts, false, 'a known non-reasoning model says so')
})

test('catalogNumbers enables the risky fields, still only when they agree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const { ctx, state } = harness({ providers: blankProfile(), homePath: home })
  const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogNumbers: true })
    await settle()
  } finally {
    stub.restore()
    await rm(home, { recursive: true, force: true })
  }

  const [alpha, beta] = state.providers['example-route'].models
  // beta's values were disclosed by one entry only, so they are usable.
  assert.equal(beta.contextWindow, 400000)
  assert.equal(beta.maxTokens, 8000)
  // alpha stays withheld: the opt-in does not override a contradiction.
  assert.equal(alpha.contextWindow, undefined)
})

test('endpoint values always win over the catalog', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const { ctx, state } = harness({ providers: blankProfile(), homePath: home })
  const listing = {
    data: [
      {
        id: 'alpha',
        context_length: 123456,
        architecture: { input_modalities: ['text'] },
      },
      { id: 'beta' },
    ],
  }
  const stub = stubFetch({ '/models': listing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogNumbers: true })
    await settle()
  } finally {
    stub.restore()
    await rm(home, { recursive: true, force: true })
  }
  const [alpha] = state.providers['example-route'].models
  assert.equal(alpha.contextWindow, 123456, 'the endpoint value wins')
  assert.deepEqual(alpha.input, ['text'], 'the endpoint modality list wins')
})

test('catalogFallback: false makes no catalog request at all', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const { ctx, state } = harness({ providers: blankProfile(), homePath: home })
  const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, catalogFallback: false })
    await settle()
  } finally {
    stub.restore()
    await rm(home, { recursive: true, force: true })
  }
  assert.equal(
    stub.calls.some((url) => url.includes('models.dev')),
    false,
    'no catalog request is made',
  )
  assert.equal(state.writes.length, 0, 'nothing is fillable without the catalog')
})

test('the catalog is cached, so a second pass does not download it again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  try {
    const first = harness({ providers: blankProfile(), homePath: home })
    const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
    try {
      apply(first.ctx, { startupDelayMs: 0, debounceMs: 0 })
      await settle()
    } finally {
      stub.restore()
    }
    const cacheFile = join(home, 'cache', 'model-capability-detector', 'catalog.json')
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(typeof cached.fetchedAt, 'number')
    assert.ok(Array.isArray(cached.groups))

    // A fresh plugin instance with the same home must not hit the network.
    const second = harness({ providers: blankProfile(), homePath: home })
    const stubAgain = stubFetch({ '/models': bareListing, 'models.dev': catalog })
    try {
      apply(second.ctx, { startupDelayMs: 0, debounceMs: 0 })
      await settle()
    } finally {
      stubAgain.restore()
    }
    assert.equal(
      stubAgain.calls.some((url) => url.includes('models.dev')),
      false,
      'the cached catalog is reused',
    )
    assert.ok(second.state.writes.length > 0, 'the cached catalog still fills values')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a failing catalog does not stop endpoint detection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const { ctx, state, logs } = harness({ providers: blankProfile(), homePath: home })
  const listing = {
    data: [{ id: 'alpha', context_length: 111, supports_vision: true }],
  }
  const stub = stubFetch({ '/models': listing, 'models.dev': 'fail' })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
    await settle()
  } finally {
    stub.restore()
    await rm(home, { recursive: true, force: true })
  }
  const [alpha] = state.providers['example-route'].models
  assert.equal(alpha.contextWindow, 111, 'endpoint data still lands')
  assert.ok(
    logs.some((entry) => entry.level === 'warn' && entry.message.includes('catalog')),
    'the catalog failure is reported',
  )
})

test('with no home path service the catalog is skipped, not crashed', async () => {
  const { ctx, state, logs } = harness({ providers: blankProfile(), homePath: '' })
  // Remove the service entirely, as a headless boot without it would.
  const originalGet = ctx.get
  ctx.get = () => undefined
  const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
    await settle()
  } finally {
    stub.restore()
    ctx.get = originalGet
  }
  assert.equal(state.writes.length, 0)
  assert.ok(
    logs.some((entry) => entry.message.includes('catalog')) ||
      logs.some((entry) => entry.level === 'debug'),
    'the skip is observable',
  )
})

test('the diagnostics log records the decisions a user needs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const logFile = join(home, 'logs', 'detector.log')
  const { ctx } = harness({ providers: blankProfile(), homePath: home })
  const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0, logFile })
    await settle()
  } finally {
    stub.restore()
  }
  let text
  try {
    text = await readFile(logFile, 'utf8')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((entry) => entry.event)
  assert.ok(events.includes('pass-start'), 'the pass is recorded')
  assert.ok(events.includes('catalog-loaded'), 'the catalog load is recorded')
  assert.ok(events.includes('catalog-withheld'), 'a withheld value explains itself')
  assert.ok(events.includes('pass-written'), 'the write is recorded')
  // Nothing credential-shaped may appear.
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(text), false)
})

test('the announcement of our own write does not trigger another probe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-fallback-'))
  const listeners = { 'settings/document-updated': [], 'app-boot/config-reload': [] }
  const state = { providers: blankProfile(), revision: 1, writes: 0 }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: (name) => (name === 'dshHomePath' ? (...p) => join(home, ...p) : undefined),
    on: (event, handler) => {
      if (listeners[event] !== undefined) listeners[event].push(handler)
      return () => {}
    },
    effect: (register) => {
      register()
      return () => {}
    },
    credentials: { resolve: async () => undefined },
    settings: {
      describe: () => [
        {
          ns: 'llm-pi-ai',
          revision: state.revision,
          value: { providers: state.providers },
          base: { providers: state.providers },
          user: { providers: state.providers },
          applies: 'live',
        },
      ],
      update: async (ns, patch, revision) => {
        state.writes += 1
        state.providers = mergeDeep(state.providers, patch.providers)
        state.revision += 1
      },
    },
  }
  const stub = stubFetch({ '/models': bareListing, 'models.dev': catalog })
  try {
    apply(ctx, { startupDelayMs: 0, debounceMs: 0 })
    await settle()
    assert.equal(state.writes, 1, 'the first pass writes once')
    const probesAfterFirstPass = stub.calls.length
    // Announce the write the plugin just made, as the settings service does.
    for (const handler of listeners['settings/document-updated']) handler('llm-pi-ai', 2)
    await settle()
    assert.equal(state.writes, 1, 'the echo writes nothing further')
    assert.equal(
      stub.calls.length,
      probesAfterFirstPass,
      'the echo does not re-probe the endpoints',
    )
  } finally {
    stub.restore()
    await rm(home, { recursive: true, force: true })
  }
})
