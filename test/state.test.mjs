import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createProvenance, provenanceKey } from '../lib/provenance.js'
import { registerUpdates } from '../lib/update-host.js'
import { resolveName, toLookup } from '../lib/catalog.js'
import { apply } from '../index.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore, validateField } from '../lib/settings.js'

const snapshotId = 'deepseek-v4.1-flash-1017'
test('pinned official snapshot works without a community catalog', () => {
  const answer = resolveName(toLookup(undefined), snapshotId)
  assert.equal(answer.safe.contextWindow, 1048576)
  assert.equal(answer.safe.maxTokens, 393216)
  assert.equal(answer.sources.contextWindow.kind, 'official-verified')
  assert.equal(answer.sources.contextWindow.verifiedAt, '2026-10-31')
})

test('API fields win and official snapshot fills blanks even when no catalog home is available', async () => {
  const original = globalThis.fetch
  let providers = { route: { baseURL: 'https://channel.test/v1', models: [{ id: snapshotId }] } }
  let writes = 0
  const cleanups = []
  globalThis.fetch = async () => Response.json({ data: [{ id: snapshotId, context_length: 500000 }] })
  const ctx = {
    get: () => undefined, on() {}, effect: (fn) => { cleanups.push(fn()) },
    logger: { debug() {}, info() {}, warn() {}, error() {} }, credentials: {},
    settings: { describe: () => [{ ns: 'llm-pi-ai', user: { providers }, revision: 1 }],
      update: async (_ns, patch) => { writes++; providers = patch.providers } },
  }
  try {
    apply(ctx, { startupDelayMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(writes, 1)
    assert.equal(providers.route.models[0].contextWindow, 500000)
    assert.equal(providers.route.models[0].maxTokens, 393216)
  } finally { cleanups.forEach((fn) => fn?.()); globalThis.fetch = original }
})

test('receipt journal serializes writes without storing private route or endpoint', async (t) => {
  let stored
  const mocks = [
    t.mock.method(fs, 'readFile', async () => { if (!stored) throw new Error('absent'); return stored }),
    t.mock.method(fs, 'mkdir', async () => {}),
    t.mock.method(fs, 'writeFile', async (_path, text) => { stored = text }),
    t.mock.method(fs, 'rename', async () => undefined),
  ]
  syncBuiltinESMExports()
  try {
    const store = createProvenance('memory-only')
    await Promise.all(['contextWindow', 'maxTokens'].map((field) => store.record([{ route: 'private-route-name', model: 'private-alias', field, value: 1000, source: { kind: 'channel-api', channelVerified: true } }])))
    await store.flush()
    const receipts = JSON.parse(stored).receipts
    assert.equal(Object.keys(receipts).length, 2)
    assert.equal(receipts[provenanceKey('private-route-name', 'private-alias', 'contextWindow')].value, 1000)
    assert.equal(stored.includes('private-route-name'), false)
    assert.equal(stored.includes('private-alias'), false)
  } finally { mocks.forEach((mock) => mock.mock.restore()); syncBuiltinESMExports() }
})

test('Host update route is lazy and read-only; tool and UI share the same check', async () => {
  const original = globalThis.fetch
  let route, tool, calls = 0
  const cleanups = []
  const services = { connection: { fetch: { register: (value) => { route = value; return async () => {} } } }, tools: { register: (value) => { tool = value } } }
  globalThis.fetch = async () => { calls++; return Response.json({ tag_name: 'v9.0.0', draft: false, prerelease: false, body: 'notes' }) }
  try {
    registerUpdates({ get: (key) => services[key], effect: (fn) => { cleanups.push(fn()) } }, {})
    const request = (input) => new Request('https://local.test/api/model-capability-detector/updates', input ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-model-capability-detector': '1' }, body: JSON.stringify(input) } : {})
    assert.equal((await (await route.fetch(request())).json()).status, 'unchecked')
    assert.equal(calls, 0)
    assert.equal((await route.fetch(request({ action: 'install', confirm: true }))).status, 400)
    assert.equal(calls, 0)
    assert.equal((await tool.execute({ action: 'check' })).version, '9.0.0')
    assert.equal((await (await route.fetch(request())).json()).version, '9.0.0')
    assert.equal(calls, 1)
  } finally { cleanups.forEach((fn) => { if (typeof fn === 'function') fn() }); globalThis.fetch = original }
})

test('settings route refuses a write without the custom header, a foreign content type, or a stale revision', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-route-'))
  const routes = new Map()
  const services = { connection: { fetch: { register: (value) => { routes.set(value.path, value); return async () => {} } } } }
  const cleanups = []
  const settings = createSettingsStore({ home })
  try {
    registerUpdates({ get: (key) => services[key], effect: (fn) => { cleanups.push(fn()) } }, { settings })
    const route = routes.get('/api/model-capability-detector/settings')
    const read = await (await route.fetch(new Request('https://local.test/s'))).json()
    const post = (body, headers = { 'content-type': 'application/json', 'x-model-capability-detector': '1' }) =>
      route.fetch(new Request('https://local.test/s', { method: 'POST', headers, body: JSON.stringify(body) }))
    assert.equal((await post({ revision: read.revision, set: { logging: true } }, { 'content-type': 'application/json' })).status, 403)
    assert.equal((await post({ revision: read.revision, set: { logging: true } }, { 'content-type': 'text/plain', 'x-model-capability-detector': '1' })).status, 415)
    assert.equal((await post({ revision: 'stale', set: { logging: true } })).status, 409)
    assert.equal((await post({ revision: read.revision, set: { timeoutMs: 0 } })).status, 400)
    assert.equal((await post({ revision: read.revision, set: { logFile: '../outside.log' } })).status, 400)
    assert.equal(settings.effective().logging, false, 'refused writes change nothing')
    const saved = await post({ revision: read.revision, set: { logging: true } })
    assert.equal(saved.status, 200)
    const body = await saved.json()
    assert.equal(body.effective.logging, true)
    assert.deepEqual(body.overrides, { logging: true })
    assert.notEqual(body.revision, read.revision)
  } finally { cleanups.forEach((fn) => { if (typeof fn === 'function') fn() }); await rm(home, { recursive: true, force: true }) }
})

test('settings layers: defaults, patch config and GUI overrides; reset falls back one layer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-layers-'))
  const invalid = []
  try {
    const store = createSettingsStore({ home, patch: { timeoutMs: 20000, debounceMs: -5, unknownKey: 1 }, onInvalid: (keys) => invalid.push(...keys) })
    assert.deepEqual(invalid, ['debounceMs'])
    assert.equal(store.effective().timeoutMs, 20000)
    assert.equal(store.effective().debounceMs, 800)
    let result = await store.update({ revision: store.snapshot().revision, set: { timeoutMs: 5000 } })
    assert.equal(result.ok, true)
    assert.equal(store.effective().timeoutMs, 5000)
    result = await store.update({ revision: store.snapshot().revision, unset: ['timeoutMs'] })
    assert.equal(store.effective().timeoutMs, 20000, 'reset returns to the patch value, not the built-in default')
    assert.equal(store.snapshot().defaults.timeoutMs, 20000)
    const again = createSettingsStore({ home })
    assert.equal(again.effective().timeoutMs, 15000, 'a fresh store without patch config shows built-in defaults')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a settings file edited by hand is validated, and read-only without a home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcd-file-'))
  try {
    const directory = join(home, 'model-capability-detector')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }))
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ overrides: { logging: true, timeoutMs: 'fast', catalogUrl: 'ftp://x/y', surprise: 1 } }))
    const store = createSettingsStore({ home })
    assert.equal(store.effective().logging, true)
    assert.equal(store.effective().timeoutMs, 15000)
    assert.equal(store.effective().catalogUrl, 'https://models.dev/api.json')
    const memory = createSettingsStore({})
    assert.equal(memory.snapshot().writable, false)
    assert.equal((await memory.update({ revision: memory.snapshot().revision, set: { logging: true } })).reason, 'read-only')
    assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).overrides.surprise, 1, 'reading never rewrites the file')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('field validation rejects credentials in URLs and log paths that leave DSH home', () => {
  assert.equal(validateField('catalogUrl', 'https://user:pass@example.test/api.json').ok, false)
  assert.equal(validateField('catalogUrl', 'file:///etc/passwd').ok, false)
  assert.equal(validateField('catalogUrl', 'https://example.test/api.json').ok, true)
  for (const bad of ['../x.log', 'a/../../x.log', 'C:\\x.log', '/etc/x.log', '\\\\host\\share\\x.log', '~/../x.log']) {
    assert.equal(validateField('logFile', bad, { strict: true }).ok, false, bad)
  }
  assert.equal(validateField('logFile', 'logs/mcd.log', { strict: true }).ok, true)
  assert.equal(validateField('logFile', '~/logs/mcd.log', { strict: true }).ok, true)
  assert.equal(validateField('logFile', 'C:\\kept-for-old-configs.log').ok, true, 'the patch layer keeps its historical latitude')
  assert.equal(validateField('settingsNs', 'Bad NS').ok, false)
})