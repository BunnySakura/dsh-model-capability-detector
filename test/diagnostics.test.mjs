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

import { createDiagnostics, redactUrl, sanitizeMessage } from '../lib/diagnostics.js'

/** Run `body` with a disposable temp directory. */
async function withTempDir(body) {
  const directory = await mkdtemp(join(tmpdir(), 'mcd-diag-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('sanitizeMessage redacts URL credentials and inline secrets without stringifying objects', () => {
  const message = 'GET https://user:pass@gateway.example/v1/models?api_key=url-secret#fragment Authorization: Bearer header-secret api_key=assignment-secret'
  const safe = sanitizeMessage(message)
  assert.equal(safe.includes('user'), false)
  assert.equal(safe.includes('url-secret'), false)
  assert.equal(safe.includes('fragment'), false)
  assert.equal(safe.includes('header-secret'), false)
  assert.equal(safe.includes('assignment-secret'), false)
  assert.ok(safe.includes('gateway.example/v1/models'))
  assert.equal(sanitizeMessage(17), '17')
  assert.equal(sanitizeMessage('Bearer bare-secret'), 'Bearer [REDACTED]')
  assert.equal(sanitizeMessage('password="two word secret"'), 'password=[REDACTED]')
  assert.equal(sanitizeMessage('apiKey=camel-secret token=token-secret key=key-secret'), 'apiKey=[REDACTED] token=[REDACTED] key=[REDACTED]')
  assert.equal(sanitizeMessage('https://user:pass@[broken]/models?token=secret#fragment'), 'https://[broken]/models')
  assert.equal(sanitizeMessage('https://host.example/path#secret'), 'https://host.example/path')
  const error = new Error('Bearer error-secret https://u:p@host.example/path?key=query-secret', {
    cause: { message: 'cause-secret' },
  })
  error.toString = () => { throw new Error('do not stringify Error') }
  assert.equal(sanitizeMessage(error), 'Bearer [REDACTED] https://host.example/path')
  const arbitrary = {
    message: 'arbitrary-secret',
    toJSON() { throw new Error('do not serialize arbitrary objects') },
    toString() { throw new Error('do not stringify arbitrary objects') },
  }
  assert.equal(sanitizeMessage(arbitrary), '[Unsupported diagnostic value]')
})

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
    // Cross the threshold with non-UTF-8 bytes to verify a byte-for-byte copy.
    const previous = Buffer.alloc(2 * 1024 * 1024 + 1, 0xff)
    await writeFile(path, previous)
    const diagnostics = createDiagnostics(path)
    diagnostics.write('after-rotation', { ok: true })
    await diagnostics.flush()

    const rotated = await readFile(`${path}.1`)
    assert.deepEqual(rotated, previous, 'the previous bytes are retained once')
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

test('write recursively sanitizes details and never serializes Error causes', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'diag.log')
    const diagnostics = createDiagnostics(path)
    const cause = { apiKey: 'cause-secret', toJSON() { throw new Error('must not serialize cause') } }
    const error = new Error('failed https://u:p@gateway.example/path?token=url-secret')
    error.cause = cause
    diagnostics.write('route-probed', {
      model: 'model-name-is-retained',
      message: 'Authorization: Bearer message-secret api_key=inline-secret',
      url: 'https://gateway.example/models?key=query-secret#fragment',
      nested: [{ apiKey: 'field-secret', note: 'password=string-secret' }],
      headers: { authorization: 'header-secret', 'x-api-key': 'header-key-secret' },
      requestHeaders: { 'x-custom': 'custom-header-secret' },
      credentials: { username: 'credential-user', password: 'credential-password' },
      modelNote: 'model-name token=model-secret',
      error,
    })
    let getterCalled = false
    const detail = { nested: { toJSON() { throw new Error('must not invoke toJSON') } } }
    Object.defineProperty(detail, 'getter', { enumerable: true, get() { getterCalled = true; return 'getter-secret' } })
    detail.self = detail
    diagnostics.write('Bearer event-secret', detail)
    await diagnostics.flush()

    const text = await readFile(path, 'utf8')
    for (const secret of ['url-secret', 'message-secret', 'inline-secret', 'query-secret', 'field-secret', 'string-secret', 'header-secret', 'header-key-secret', 'custom-header-secret', 'credential-user', 'credential-password', 'model-secret', 'event-secret', 'getter-secret', 'cause-secret']) {
      assert.equal(text.includes(secret), false, `${secret} must not reach the log`)
    }
    assert.equal(getterCalled, false)
    assert.equal(text.trim().split('\n').length, 2)
    assert.ok(text.includes('[Circular]'))
    assert.ok(text.includes('model-name-is-retained'))
    assert.ok(text.includes('gateway.example/path'))
    assert.ok(text.includes('gateway.example/models'))
    assert.equal(text.includes('must not serialize cause'), false)
  })
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
