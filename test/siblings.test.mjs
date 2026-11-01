import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toLookup } from '../lib/catalog.js'
import { writeFileAtomic } from '../lib/fsutil.js'
import { resolveSibling } from '../lib/official.js'
import { UPGRADE_BELOW_RANK } from '../lib/plan.js'
import { createProvenance, provenanceKey } from '../lib/provenance.js'
import { rankOf, resolveTiered } from '../lib/tiers.js'

const efforts = { off: null, low: 'low', high: 'high', max: 'max' }
const record = (id, safe, vendor = 'acme') => ({ vendor, id, canonical: `${vendor}/${id}`, doc: `https://docs.${vendor}.test/`, safe })

test('an unpinned name inherits reasoning levels from its verified snapshot, and nothing numeric', () => {
  const answer = resolveTiered(toLookup(undefined), undefined, 'deepseek-v4.1-flash')
  assert.deepEqual(answer.safe.reasoningEfforts, efforts)
  assert.equal(answer.sources.reasoningEfforts.kind, 'official-sibling')
  assert.equal(answer.sources.reasoningEfforts.match, 'sibling')
  assert.equal(answer.safe.contextWindow, undefined)
  assert.equal(answer.safe.maxTokens, undefined)
  assert.equal(answer.reasons.reasoningEfforts, undefined)
  assert.equal(answer.status, 'resolved')
})

test('gateway prefixes and variants still reach the snapshot line; other lines and tagged names do not', () => {
  const inherited = (id) => resolveTiered(toLookup(undefined), undefined, id).safe.reasoningEfforts
  assert.deepEqual(inherited('gateway/DeepSeek-V4.1-Flash:free'), efforts)
  assert.equal(inherited('deepseek-v4.1-flash-0423'), undefined, 'a different snapshot never borrows')
  assert.equal(inherited('deepseek-v4.2-flash'), undefined)
  assert.equal(inherited('dsv4.1flash'), undefined)
})

test('siblings must agree, share one vendor, and carry a real snapshot tag', () => {
  const agree = [record('m-0101', { reasoningEfforts: efforts }), record('m-0202', { reasoningEfforts: efforts })]
  assert.equal(resolveSibling(agree, 'm'), undefined, 'a stem this short is too generic to trust')
  const named = [record('model-x-0101', { reasoningEfforts: efforts }), record('model-x-0202', { reasoningEfforts: efforts })]
  assert.deepEqual(resolveSibling(named, 'model-x').value, efforts)
  const split = [record('model-x-0101', { reasoningEfforts: efforts }), record('model-x-0202', { reasoningEfforts: false })]
  assert.equal(resolveSibling(split, 'model-x'), undefined, 'disagreeing snapshots withhold the value')
  const vendors = [record('model-x-0101', { reasoningEfforts: efforts }), record('model-x-0202', { reasoningEfforts: efforts }, 'other')]
  assert.equal(resolveSibling(vendors, 'model-x'), undefined, 'two vendors are two identities')
  const versions = [record('qwen-big-2507', { reasoningEfforts: efforts })]
  assert.equal(resolveSibling(versions, 'qwen-big'), undefined, '2507 is a version, not a month and day')
  const dated = [record('model-y-20241022', { reasoningEfforts: efforts })]
  assert.deepEqual(resolveSibling(dated, 'model-y').value, efforts)
  assert.equal(resolveSibling(dated, 'model-y-20250101'), undefined)
})

test('sibling evidence ranks between the mirror and third-party consensus, and stays upgradable', () => {
  const kinds = ['channel-api', 'official-verified', 'original-provider-mirror', 'official-sibling', 'third-party-consensus', 'api-hint', 'legacy-catalog']
  const ranks = kinds.map((kind) => rankOf({ kind }))
  assert.deepEqual([...ranks].sort((a, b) => b - a), ranks)
  assert.equal(new Set(ranks).size, kinds.length)
  assert.equal(rankOf({ kind: 'official-sibling' }) < UPGRADE_BELOW_RANK, true)
  assert.equal(rankOf({ kind: 'original-provider-mirror' }) < UPGRADE_BELOW_RANK, true)
  assert.equal(rankOf({ kind: 'official-verified' }) < UPGRADE_BELOW_RANK, false)
})

test('atomic writes replace the file and leave no temporary sibling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcd-atomic-'))
  try {
    const file = join(dir, 'nested', 'state.json')
    await writeFileAtomic(file, 'first')
    await writeFileAtomic(file, 'second')
    assert.equal(await readFile(file, 'utf8'), 'second')
    assert.deepEqual(await readdir(join(dir, 'nested')), ['state.json'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('re-recording a receipt makes it the newest entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcd-receipts-'))
  try {
    const store = createProvenance(dir)
    const entry = (model) => ({ route: 'r', model, field: 'contextWindow', value: 1, source: { kind: 'api-hint' } })
    await store.record([entry('a'), entry('b')])
    await store.record([entry('a')])
    const parsed = JSON.parse(await readFile(join(dir, 'cache', 'model-capability-detector', 'provenance.json'), 'utf8'))
    assert.deepEqual(Object.keys(parsed.receipts), [provenanceKey('r', 'b', 'contextWindow'), provenanceKey('r', 'a', 'contextWindow')])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
