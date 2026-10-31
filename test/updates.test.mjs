import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, parseVersion, readRelease, createUpdateChecker, RELEASES_URL } from '../lib/updates.js'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const release = (tag = 'v1.3.0') => ({ tag_name: tag, draft: false, prerelease: false, body: '<script>not executed</script> release notes', published_at: '2026-10-31T00:00:00Z', html_url: 'https://evil.test', tarball_url: 'https://evil.test/archive' })

test('strict semantic versions compare without lexicographic or prerelease mistakes', () => {
  for (const [a, b] of [['1.10.0', '1.9.0'], ['2.0.0', '1.99.0'], ['1.2.0', '1.2.0-rc.9'], ['1.2.0-rc.10', '1.2.0-rc.2']]) assert.equal(compareVersions(a, b), 1)
  assert.equal(compareVersions('v1.2.0+build', '1.2.0'), 0)
  for (const raw of ['1.02.0', '1.0', '1.2.3-01', 'v1.3.0;command', '../../main', '1.2.3\n']) assert.equal(parseVersion(raw), undefined, raw)
})

test('release metadata cannot choose installation repo or HTML destination', () => {
  const answer = readRelease(release(), '1.2.0')
  assert.equal(answer.available, true)
  assert.equal(answer.installTarget, 'git+https://github.com/BunnySakura/dsh-model-capability-detector.git#v1.3.0')
  assert.equal(answer.releaseUrl, 'https://github.com/BunnySakura/dsh-model-capability-detector/releases/tag/v1.3.0')
  assert.equal(readRelease(release('v1.1.0'), '1.2.0').available, false)
  for (const invalid of [{ ...release(), draft: true }, { ...release(), prerelease: true }, release('1.3.0-beta'), release('main')]) assert.throws(() => readRelease(invalid, '1.2.0'))
})

test('checker is lazy, caches and coalesces checks, and sends no provider data', async () => {
  const calls = []
  let clock = 10000
  const checker = createUpdateChecker({ currentVersion: '1.2.0', now: () => clock, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(release()))
  } })
  assert.equal(checker.snapshot().status, 'unchecked')
  assert.equal(calls.length, 0)
  const [a, b] = await Promise.all([checker.check(), checker.check()])
  assert.deepEqual(a, b)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, RELEASES_URL)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].init.headers.authorization, undefined)
  await checker.check()
  assert.equal(calls.length, 1)
  clock -= 1000
  await checker.check()
  assert.equal(calls.length, 2, 'clock rollback invalidates freshness')
  await checker.check({ refresh: true })
  assert.equal(calls.length, 3)
})

test('errors return bounded safe status and cancel error bodies', async () => {
  for (const [status, expected] of [[404, 'no-release'], [403, 'rate-limited'], [429, 'rate-limited'], [500, 'unavailable']]) {
    let cancelled = false
    const checker = createUpdateChecker({ currentVersion: '1.2.0', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status }) })
    assert.equal((await checker.check()).status, expected)
    assert.equal(cancelled, true)
  }
  const checker = createUpdateChecker({ currentVersion: '1.2.0', fetchImpl: async () => { throw new Error('synthetic-private-data') } })
  assert.equal(JSON.stringify(await checker.check()).includes('synthetic-private-data'), false)
})

test('cancelled checker sends no request', async () => {
  const controller = new AbortController()
  controller.abort()
  const checker = createUpdateChecker({ currentVersion: '1.2.0', signal: controller.signal, fetchImpl: () => { throw new Error('must not run') } })
  assert.equal((await checker.check()).status, 'cancelled')
})

test('client confirmation hands a fixed target to the native DSH installation dialog', async () => {
  let definition, Component, installed
  const states = [{ status: 'checked', ...readRelease(release(), '1.2.0') }, false, false]
  let index = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => { const position = index++; return [states[position], (value) => { states[position] = value }] },
    useRef: () => ({ current: true }), useEffect() {},
  }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value) => { definition = value } } },
    document: { baseURI: 'http://127.0.0.1:8465/' }, URL,
  })
  const plugin = definition.factory(() => React)
  plugin.apply({ effect: (fn) => fn(), locale: { register() {}, bind: () => (key) => key },
    slots: { inject: (_key, fn) => fn(), register: (options, component) => { assert.equal(options.name, 'plugins.tab'); Component = component } } })
  const props = { install: (value) => { installed = value } }
  const render = () => { index = 0; return Component(props) }
  const flatten = (node) => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(flatten)]
  const initial = flatten(render())
  assert.equal(installed, undefined)
  initial.find((node) => node.type === 'button' && node.children.includes('update')).props.onClick()
  assert.equal(installed, undefined)
  const confirmation = flatten(render()).find((node) => node.type === 'button' && node.children.includes('confirm'))
  confirmation.props.onClick()
  assert.equal(installed.spec, 'git+https://github.com/BunnySakura/dsh-model-capability-detector.git#v1.3.0')
  assert.equal(installed.version, '1.3.0')
  assert.equal(installed.approvedBuilds, undefined)
})
