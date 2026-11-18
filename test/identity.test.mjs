import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, matchKey, toLookup } from '../lib/catalog.js'
import { validateField } from '../lib/settings.js'
import { createDiagnostics } from '../lib/diagnostics.js'
import { nameKeys } from '../lib/names.js'
import { resolveOfficial, resolveSibling, VERIFIED } from '../lib/official.js'
import { mergeDetected } from '../lib/plan.js'
import { buildSourceIndex, toSourceLookup, voteFor } from '../lib/sources.js'
import { resolveTiered } from '../lib/tiers.js'

const row = (id) => ({ vendor: 'acme', id, canonical: `acme/${id}`, safe: { contextWindow: 200000, reasoningEfforts: { high: 'high' } } })

test('a full-date snapshot never lends its numeric limits to another snapshot or floating name', () => {
  for (const date of ['20250101', '2025-01-01']) {
    const records = [row(`model-x-${date}`)]
    assert.equal(resolveOfficial(records, `gateway/model-x-${date}`).safe.contextWindow, 200000)
    for (const requested of ['model-x', 'model-x-20250202', 'model-x-2025-02-02']) {
      assert.equal(resolveOfficial(records, requested).status, 'unknown', requested)
    }
    assert.deepEqual(resolveSibling(records, 'model-x').value, { high: 'high' })
    assert.equal(resolveSibling(records, 'model-x', 'contextWindow'), undefined)
  }
})

test('verified records remain available offline with gateway prefixes and cosmetic punctuation', () => {
  for (const record of VERIFIED) {
    for (const requested of [`gateway/${record.id}`, record.id.replaceAll('-', '_')]) {
      const resolved = resolveOfficial([], requested)
      assert.equal(resolved.safe.contextWindow, record.safe.contextWindow)
      assert.equal(resolved.sources.contextWindow.kind, 'official-verified')
    }
  }
})

test('variants retain their own capacities and unknown variants never borrow the base model', () => {
  const lookup = toSourceLookup(buildSourceIndex('openrouter', { data: [
    { id: 'acme/model-x', context_length: 200000 },
    { id: 'acme/model-x:free', context_length: 32000 },
  ] }))
  assert.equal(voteFor(lookup, 'model-x').context, 200000)
  assert.equal(voteFor(lookup, 'model-x:free').context, 32000)
  assert.equal(voteFor(lookup, 'model-x:thinking'), undefined)
  assert.notEqual(nameKeys('model-x:free').compact, nameKeys('model-x-free').compact)
  assert.notEqual(matchKey('model-x:free'), matchKey('model-x-free'))
  assert.equal(resolveOfficial([row('model-x')], 'model-x:free').status, 'unknown')
})

test('public-source family keys do not merge full-date snapshots', () => {
  const lookup = toSourceLookup(buildSourceIndex('openrouter', { data: [
    { id: 'acme/model-x-20250101', context_length: 200000 },
  ] }))
  assert.equal(voteFor(lookup, 'model-x'), undefined)
  assert.equal(voteFor(lookup, 'model-x-20250202'), undefined)
})

test('an explicit alias supplies metadata without rewriting the gateway request id', () => {
  const record = VERIFIED[0]
  const requested = 'my-deployment:custom'
  const resolved = resolveTiered(toLookup(undefined), undefined, requested, { aliases: { [requested]: record.canonical } })
  assert.equal(resolved.aliased, true)
  assert.equal(resolved.safe.contextWindow, record.safe.contextWindow)
  const merged = mergeDetected({ route: { models: [{ id: requested }] } }, new Map(), false, {
    resolve: () => resolved, allowedFields: ['contextWindow'],
  })
  assert.equal(merged.providers.route.models[0].id, requested)
  assert.equal(merged.providers.route.models[0].contextWindow, record.safe.contextWindow)
})

test('logging refuses configuration filenames and leaves existing bytes intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcd-identity-'))
  try {
    for (const name of ['settings.json', 'cordis.patch.yml', 'package.json']) {
      const path = join(directory, name)
      const original = '{"unchanged":true}\n'
      await writeFile(path, original)
      assert.equal(validateField('logFile', path).ok, false)
      const logger = createDiagnostics(path)
      assert.equal(logger.enabled, false)
      logger.write('anything', {})
      await logger.flush()
      assert.equal(await readFile(path, 'utf8'), original)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})


test('models.dev consensus cannot confuse a colon variant with a hyphenated model name', () => {
  const lookup = toLookup(buildIndex({ one: { models: {
    x: { id: 'model-x:free', limit: { context: 32000 } },
  } } }))
  assert.equal(resolveTiered(lookup, undefined, 'model-x-free').votes.models_dev, undefined)
})
