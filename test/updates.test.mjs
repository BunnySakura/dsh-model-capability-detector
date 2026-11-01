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

const SHA = 'a'.repeat(40)
/** A fetch double for an empty-bodied release; `tagRef` and `tagObject` choose the follow-up answers. */
function emptyRelease({ tagRef, tagObject }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === RELEASES_URL) return Response.json({ ...release('1.5.0'), body: '' })
    if (String(url).includes('/git/ref/tags/')) return tagRef ?? new Response('{}', { status: 404 })
    return tagObject ?? new Response('{}', { status: 404 })
  }
  return { calls, fetchImpl }
}

test('an empty release body falls back to the annotated tag message', async () => {
  const { calls, fetchImpl } = emptyRelease({
    tagRef: Response.json({ object: { type: 'tag', sha: SHA } }),
    tagObject: Response.json({ message: '  1.5.0\n\n新增与变更\n- 内容  \n' }),
  })
  const answer = await createUpdateChecker({ currentVersion: '1.4.0', fetchImpl }).check()
  assert.equal(answer.status, 'checked')
  assert.equal(answer.notes, '1.5.0\n\n新增与变更\n- 内容')
  assert.deepEqual(calls.map((call) => call.url), [
    RELEASES_URL,
    'https://api.github.com/repos/BunnySakura/dsh-model-capability-detector/git/ref/tags/1.5.0',
    `https://api.github.com/repos/BunnySakura/dsh-model-capability-detector/git/tags/${SHA}`,
  ])
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.headers.authorization, undefined)
  }
})

test('tag fallback leaves notes empty for a lightweight tag, a failed request, or a malformed object id', async () => {
  const cases = [
    { tagRef: Response.json({ object: { type: 'commit', sha: SHA } }) },
    {},
    { tagRef: Response.json({ object: { type: 'tag', sha: '../../etc' } }) },
    { tagRef: Response.json({ object: { type: 'tag', sha: SHA } }), tagObject: new Response('not json', { status: 200 }) },
    { tagRef: Response.json({ object: { type: 'tag', sha: SHA } }), tagObject: Response.json({ message: 42 }) },
  ]
  for (const doubles of cases) {
    const answer = await createUpdateChecker({ currentVersion: '1.4.0', fetchImpl: emptyRelease(doubles).fetchImpl }).check()
    assert.equal(answer.status, 'checked', 'the update check itself still succeeds')
    assert.equal(answer.notes, '')
  }
})

test('tag fallback message is bounded, and a written release body skips the extra requests', async () => {
  const long = emptyRelease({ tagRef: Response.json({ object: { type: 'tag', sha: SHA } }), tagObject: Response.json({ message: 'x'.repeat(50000) }) })
  assert.equal((await createUpdateChecker({ currentVersion: '1.4.0', fetchImpl: long.fetchImpl }).check()).notes.length, 12000)
  const calls = []
  const written = createUpdateChecker({ currentVersion: '1.2.0', fetchImpl: async (url) => { calls.push(String(url)); return Response.json(release()) } })
  assert.equal((await written.check()).notes.includes('release notes'), true)
  assert.deepEqual(calls, [RELEASES_URL])
})

test('cancelled checker sends no request', async () => {
  const controller = new AbortController()
  controller.abort()
  const checker = createUpdateChecker({ currentVersion: '1.2.0', signal: controller.signal, fetchImpl: () => { throw new Error('must not run') } })
  assert.equal((await checker.check()).status, 'cancelled')
})

test('bundle page card saves through the settings route and updates through the plugin manager', async () => {
  let definition, Component
  let cursor = 0
  const hooks = [], effects = [], posts = [], installs = []
  const fields = {
    enabled: { type: 'boolean' }, updateCheckOnStartup: { type: 'boolean' }, timeoutMs: { type: 'integer', min: 1, max: 600000 },
    catalogNumericStrategy: { type: 'enum', values: ['official', 'minimum', 'consensus'] }, logFile: { type: 'path' },
  }
  let current = { enabled: true, updateCheckOnStartup: false, timeoutMs: 15000, catalogNumericStrategy: 'official', logFile: '' }
  let revision = 'r1'
  const snapshot = () => ({ ok: true, revision, writable: true, defaults: { ...current }, overrides: {}, effective: { ...current }, fields })
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const slot = cursor++
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next }]
    },
    useRef(initial) { const slot = cursor++; return hooks[slot] ??= { current: initial } },
    useEffect(effect) { const slot = cursor++; if (!effects[slot]) effects[slot] = effect() },
  }
  const text = {
    title: 'Model Capability Detector', summary: 'Configure this plugin', save: 'Save settings', check: 'Check for updates',
    update: 'Update this plugin', confirm: 'Confirm update', installApplied: 'Updated.', updates: 'Online updates', detection: 'Detection',
  }
  const locale = { register() {}, bind: () => (key) => text[key] ?? key }
  const cleanups = []
  const originalFetch = globalThis.fetch
  const stub = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path.endsWith('/settings')) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        assert.equal(init.headers['x-model-capability-detector'], '1')
        posts.push(body)
        if (body.revision !== revision) return Response.json({ ok: false, reason: 'conflict', ...snapshot() }, { status: 409 })
        Object.assign(current, body.set); revision = 'r2'
      }
      return Response.json(snapshot())
    }
    return Response.json({ status: 'checked', ...readRelease({ tag_name: 'v1.5.0', draft: false, prerelease: false, body: 'notes' }, '1.4.0') })
  }
  globalThis.fetch = stub
  const flatten = (node) => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(flatten)]
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
  try {
    runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: (value) => { definition = value } } },
      document: { baseURI: 'http://127.0.0.1:8465/' }, URL, fetch: (...args) => globalThis.fetch(...args), Date, Number, JSON, Object, Array, Set,
    })
    const plugin = definition.factory(() => React)
    assert.deepEqual([...plugin.inject], ['slots', 'locale'])
    plugin.apply({
      effect: (fn) => { cleanups.push(fn()) }, locale,
      get: (key) => key === 'remote.pluginManager' ? { installBundle: async (spec, options) => { installs.push({ spec, options }); return { ok: true, value: { application: 'applied' } } } } : undefined,
      slots: {
        inject: (name, fn) => { assert.equal(name, 'plugins.bundle.config'); fn() },
        register: (options, component) => { assert.equal(options.key, 'dsh-model-capability-detector'); assert.equal(options.name, 'plugins.bundle.config'); Component = component },
      },
    })
    assert.equal(Component({ view: 'summary' }).children[0], 'Configure this plugin')
    const page = Component({ view: 'page' })
    const render = () => { cursor = 0; return page.type(page.props) }
    render(); await tick()
    let nodes = flatten(render())
    assert.ok(nodes.some((node) => node.children?.includes('Detection')))
    assert.ok(nodes.some((node) => node.children?.includes('Online updates')))
    const limit = nodes.find((node) => node.props?.['data-config-key'] === 'timeoutMs')
    limit.props.onChange({ currentTarget: { value: '0', valueAsNumber: 0 } })
    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('Save settings')).props.onClick()
    assert.equal(posts.length, 0, 'an out-of-range number is refused in the browser')
    nodes.find((node) => node.props?.['data-config-key'] === 'timeoutMs').props.onChange({ currentTarget: { value: '9000', valueAsNumber: 9000 } })
    nodes.find((node) => node.props?.['data-config-key'] === 'updateCheckOnStartup').props.onChange({ currentTarget: { checked: true } })
    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('Save settings')).props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), { revision: 'r1', set: { timeoutMs: 9000, updateCheckOnStartup: true }, unset: [] })
    nodes = flatten(render())
    assert.equal(nodes.find((node) => node.props?.['data-config-key'] === 'timeoutMs').props.value, 9000)
    await nodes.find((node) => node.type === 'button' && node.children.includes('Check for updates')).props.onClick()
    await tick()
    nodes = flatten(render())
    nodes.find((node) => node.type === 'button' && node.children.includes('Update this plugin')).props.onClick()
    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('Confirm update')).props.onClick()
    assert.equal(installs.length, 1)
    assert.equal(installs[0].spec, 'git+https://github.com/BunnySakura/dsh-model-capability-detector.git#v1.5.0')
    assert.equal(installs[0].options.enabled, true)
    assert.match(installs[0].options.requestId, /^model-capability-detector-/)
    nodes = flatten(render())
    assert.ok(nodes.some((node) => node.children?.includes('Updated.')))
  } finally { cleanups.forEach((dispose) => typeof dispose === 'function' && dispose()); globalThis.fetch = originalFetch }
})

test('the page refuses an install target outside the fixed repository', async () => {
  let definition, Component
  let cursor = 0
  const hooks = [], effects = [], installs = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = initial; return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next }] },
    useRef(initial) { const slot = cursor++; return hooks[slot] ??= { current: initial } },
    useEffect(effect) { const slot = cursor++; if (!effects[slot]) effects[slot] = effect() },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => new URL(url).pathname.endsWith('/settings')
    ? Response.json({ ok: true, revision: 'r', writable: true, defaults: {}, overrides: {}, effective: {}, fields: {} })
    : Response.json({ status: 'checked', available: true, version: '9.9.9', installTarget: 'git+https://evil.example/repo.git#v9.9.9' })
  try {
    runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: (value) => { definition = value } } },
      document: { baseURI: 'http://127.0.0.1:8465/' }, URL, fetch: (...args) => globalThis.fetch(...args), Date, Number, JSON, Object, Array, Set,
    })
    definition.factory(() => React).apply({
      effect: () => {}, locale: { register() {}, bind: () => (key) => key },
      get: () => ({ installBundle: async (...args) => { installs.push(args); return { ok: true, value: {} } } }),
      slots: { inject: (_name, fn) => fn(), register: (_options, component) => { Component = component } },
    })
    const page = Component({ view: 'page' })
    const render = () => { cursor = 0; return page.type(page.props) }
    const flatten = (node) => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(flatten)]
    render(); await new Promise((resolve) => setTimeout(resolve, 20))
    let nodes = flatten(render())
    nodes.find((node) => node.type === 'button' && node.children.includes('update')).props.onClick()
    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('confirm')).props.onClick()
    assert.equal(installs.length, 0)
    assert.ok(flatten(render()).some((node) => node.children?.includes('installRefused')))
  } finally { globalThis.fetch = originalFetch }
})

test('the settings page edits aliases and shows the detection report and look-up', async () => {
  let definition, Component
  let cursor = 0
  const hooks = [], effects = [], posts = []
  const fields = { modelAliases: { type: 'aliases' }, thirdPartySources: { type: 'boolean' } }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = initial; return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next }] },
    useRef(initial) { const slot = cursor++; return hooks[slot] ??= { current: initial } },
    useEffect(effect) { const slot = cursor++; if (!effects[slot]) effects[slot] = effect() },
  }
  const originalFetch = globalThis.fetch
  const field = { state: 'set', value: 128000, tier: 'official' }
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path.endsWith('/settings')) {
      if (init.method === 'POST') posts.push(JSON.parse(init.body))
      return Response.json({ ok: true, revision: 'r', writable: true, defaults: {}, overrides: {}, effective: { modelAliases: { 'my-gw': 'gpt-4o' }, thirdPartySources: true }, fields })
    }
    if (path.endsWith('/detector')) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        return Response.json({ ok: true, model: body.model, status: 'resolved', fields: { contextWindow: field, maxTokens: { state: 'empty', reason: 'third-party-conflict' }, input: field, reasoningEfforts: field }, votes: { openrouter: { context: 128000, output: 16384 } } })
      }
      return Response.json({ ok: true, routes: [{ route: 'r1', models: [{ id: 'gpt-4o', matched: true, fields: { contextWindow: field, maxTokens: { state: 'empty', reason: 'third-party-conflict' }, input: field, reasoningEfforts: field } }] }] })
    }
    return Response.json({ status: 'unchecked' })
  }
  const flatten = (node) => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(flatten)]
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
  const text = (nodes) => nodes.flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string')).join('\n')
  try {
    runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: (value) => { definition = value } } },
      document: { baseURI: 'http://127.0.0.1:8465/' }, URL, fetch: (...args) => globalThis.fetch(...args), Date, Number, JSON, Object, Array, Set,
    })
    definition.factory(() => React).apply({
      effect: () => {}, locale: { register() {}, bind: () => (key) => key }, get: () => undefined,
      slots: { inject: (_name, fn) => fn(), register: (_options, component) => { Component = component } },
    })
    const page = Component({ view: 'page' })
    const render = () => { cursor = 0; return page.type(page.props) }
    render(); await tick()
    let nodes = flatten(render())
    const aliases = nodes.find((node) => node.props?.['data-config-key'] === 'modelAliases')
    assert.equal(aliases.props.value, 'my-gw = gpt-4o')
    aliases.props.onChange({ currentTarget: { value: 'my-gw = gpt-4o\nother = claude-sonnet-4-5\nbroken line' } })
    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('save')).props.onClick()
    await tick()
    assert.deepEqual(JSON.parse(JSON.stringify(posts[0].set)), { modelAliases: { 'my-gw': 'gpt-4o', other: 'claude-sonnet-4-5' } })

    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('reportLoad')).props.onClick()
    await tick()
    nodes = flatten(render())
    const shown = text(nodes)
    assert.match(shown, /gpt-4o/)
    assert.match(shown, /128000 · official/, 'a key missing from the locale falls back to the raw code')
    assert.match(shown, /stateEmpty · third-party-conflict/)

    nodes.find((node) => node.props?.['aria-label'] === 'lookup').props.onChange({ currentTarget: { value: 'my-gw' } })
    nodes = flatten(render())
    await nodes.find((node) => node.type === 'button' && node.children.includes('lookupRun')).props.onClick()
    await tick()
    assert.match(text(flatten(render())), /openrouter 128000\/16384/)
  } finally { globalThis.fetch = originalFetch }
})