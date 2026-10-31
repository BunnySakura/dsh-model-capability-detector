import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createProvenance, provenanceKey } from '../lib/provenance.js'
import { registerUpdates } from '../lib/update-host.js'
import { resolveName, toLookup } from '../lib/catalog.js'
import { apply } from '../index.js'

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
  globalThis.fetch = async () => { calls++; return Response.json({ tag_name: 'v9.0.0', draft: false, prerelease: false }) }
  try {
    registerUpdates({ get: (key) => services[key], effect: (fn) => { cleanups.push(fn()) } }, {})
    const request = (input) => new Request('https://local.test/api/model-capability-detector/updates', input ? { method: 'POST', body: JSON.stringify(input) } : {})
    assert.equal((await (await route.fetch(request())).json()).status, 'unchecked')
    assert.equal(calls, 0)
    assert.equal((await route.fetch(request({ action: 'install', confirm: true }))).status, 400)
    assert.equal(calls, 0)
    assert.equal((await tool.execute({ action: 'check' })).version, '9.0.0')
    assert.equal((await (await route.fetch(request())).json()).version, '9.0.0')
    assert.equal(calls, 1)
  } finally { cleanups.forEach((fn) => { if (typeof fn === 'function') fn() }); globalThis.fetch = original }
})
