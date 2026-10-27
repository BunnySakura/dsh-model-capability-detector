/**
 * Tests for the opt-in diagnostics log.
 *
 * Run: node --test test/diagnostics.test.mjs
 * The log exists because DSH keeps messages in memory only; these tests assert
 * it stays off unless asked, never records a credential, and cannot break the
 * pass it observes.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createDiagnostics, redactUrl } from '../lib/diagnostics.js'

/** Run `body` with a disposable temp directory. */
async function withTempDir(body) {
  const directory = await mkdtemp(join(tmpdir(), 'mcd-diag-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('an unset path disables logging entirely', async () => {
  for (const path of [undefined, null, '', 0]) {
    const diagnostics = createDiagnostics(path)
    assert.equal(diagnostics.enabled, false)
    // A disabled logger must accept calls without doing anything.
    diagnostics.write('anything', { detail: 1 })
    await diagnostics.flush()
  }
})

test('records land as newline-delimited JSON with an ISO timestamp', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'nested', 'diag.log')
    const diagnostics = createDiagnostics(path)
    assert.equal(diagnostics.enabled, true)
    diagnostics.write('pass-start', { reason: 'startup' })
    diagnostics.write('route-probed', { route: 'example', models: 3 })
    await diagnostics.flush()

    const text = await readFile(path, 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.event, 'pass-start')
    assert.equal(first.reason, 'startup')
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/)
    const second = JSON.parse(lines[1])
    assert.equal(second.models, 3)
  })
})

test('concurrent writes cannot interleave a line', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'diag.log')
    const diagnostics = createDiagnostics(path)
    // Fire many writes without awaiting, as concurrent passes would.
    for (let index = 0; index < 50; index += 1) {
      diagnostics.write('tick', { index })
    }
    await diagnostics.flush()
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 50)
    // Every line must parse on its own: a partial line would throw here.
    const indexes = lines.map((line) => JSON.parse(line).index)
    assert.deepEqual(
      indexes,
      Array.from({ length: 50 }, (_, index) => index),
      'writes keep their order',
    )
  })
})

test('a write failure is swallowed rather than breaking the caller', async () => {
  // A path whose parent is an existing file cannot be created as a directory.
  await withTempDir(async (directory) => {
    const blocker = join(directory, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const diagnostics = createDiagnostics(join(blocker, 'diag.log'))
    assert.equal(diagnostics.enabled, true)
    // Neither the call nor the flush may reject.
    diagnostics.write('pass-start', { reason: 'test' })
    await diagnostics.flush()
  })
})

test('an oversized log is rotated instead of growing without bound', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'diag.log')
    // Cross the 2 MiB rotation threshold with a single large write.
    await writeFile(path, `${'x'.repeat(2 * 1024 * 1024 + 1)}\n`, 'utf8')
    const diagnostics = createDiagnostics(path)
    diagnostics.write('after-rotation', { ok: true })
    await diagnostics.flush()

    const rotated = await readFile(`${path}.1`, 'utf8')
    assert.ok(rotated.length > 2 * 1024 * 1024, 'the previous content is retained once')
    const current = await readFile(path, 'utf8')
    const entry = JSON.parse(current.trim())
    assert.equal(entry.event, 'after-rotation')
  })
})

test('redactUrl keeps the endpoint but drops any query string', () => {
  assert.equal(
    redactUrl('https://gateway.example/v1/models?api_key=secret&x=1'),
    'https://gateway.example/v1/models',
  )
  assert.equal(redactUrl('https://gateway.example/v1'), 'https://gateway.example/v1')
  assert.equal(redactUrl('not a url'), 'not a url')
  assert.equal(redactUrl(undefined), undefined)
  // A userinfo segment must not survive either.
  assert.equal(redactUrl('https://user:pass@host.example/v1/models'), 'https://host.example/v1/models')
})

test('the log never contains a credential-shaped value from a record', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'diag.log')
    const diagnostics = createDiagnostics(path)
    // The plugin only ever logs redacted URLs and field names; prove that a
    // record built the intended way carries no secret.
    const secret = 'sk-live-abcdef0123456789'
    diagnostics.write('route-probed', {
      route: 'example',
      url: redactUrl(`https://gateway.example/v1/models?key=${secret}`),
      models: 2,
    })
    await diagnostics.flush()
    const text = await readFile(path, 'utf8')
    assert.equal(text.includes(secret), false, 'the query string carrying the key is gone')
    assert.ok(text.includes('gateway.example'))
  })
})
