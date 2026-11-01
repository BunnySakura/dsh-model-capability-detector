/** Host API mounted independently from detector enablement: settings, update check and the read-only Agent tool. */
import { readFileSync } from 'node:fs'
import { createUpdateChecker } from './updates.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const UPDATE_PATH = '/api/model-capability-detector/updates'
export const SETTINGS_PATH = '/api/model-capability-detector/settings'
/** A custom header forces a CORS preflight, so a foreign page cannot write settings. */
export const WRITE_HEADER = 'x-model-capability-detector'
const MAX_BODY = 16 * 1024

const reply = (value, code = 200) => Response.json(value, { status: code, headers: { 'cache-control': 'no-store' } })

async function readJson(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return { error: 413 }
  if (!String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { error: 415 }
  if (request.headers.get(WRITE_HEADER) !== '1') return { error: 403 }
  try {
    const text = await request.text()
    if (text.length > MAX_BODY) return { error: 413 }
    return { value: JSON.parse(text) }
  } catch { return { error: 400 } }
}

/**
 * @param ctx Cordis context.
 * @param options.config live accessor for the effective configuration.
 * @param options.settings the settings store; omitted means no settings route.
 */
export function registerUpdates(ctx, options = {}) {
  const store = options.settings
  const getConfig = typeof options.config === 'function' ? options.config : () => options.config ?? {}
  const lifetime = new AbortController()
  const checker = createUpdateChecker({ currentVersion: VERSION, signal: lifetime.signal })
  const background = () => getConfig().updateCheckOnStartup === true
  const status = () => ({ ...checker.snapshot(), backgroundCheck: background() })
  const check = async (refresh = false) => ({ ...await checker.check({ refresh }), backgroundCheck: background() })
  const withOptional = (keys, callback) => {
    if (typeof ctx.inject === 'function') ctx.inject(keys, callback)
    else if (keys.every((key) => ctx.get(key))) callback(ctx)
  }

  withOptional(['connection'], (owner) => {
    const connection = owner.get('connection')
    owner.effect(() => connection.fetch.register({
      path: UPDATE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') return reply(status())
        const body = await readJson(request)
        if (body.error !== undefined) return reply({ reason: 'invalid-request' }, body.error)
        if (body.value?.action !== 'check') return reply({ reason: 'read-only-update-endpoint' }, 400)
        return reply(await check(body.value.refresh === true))
      },
    }))
    if (store === undefined) return
    owner.effect(() => connection.fetch.register({
      path: SETTINGS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') return reply({ ok: true, version: VERSION, ...store.refresh() })
        const body = await readJson(request)
        if (body.error !== undefined) return reply({ ok: false, reason: 'invalid-request' }, body.error)
        const result = await store.update(body.value)
        if (result.ok) return reply({ ok: true, version: VERSION, ...result.snapshot })
        const code = result.reason === 'conflict' ? 409 : result.reason === 'invalid' ? 400 : result.reason === 'read-only' ? 403 : 500
        return reply({ ok: false, reason: result.reason, errors: result.errors, version: VERSION, ...result.snapshot }, code)
      },
    }))
  })

  // The same read operation is available to an Agent. Installation stays with
  // the user and the ordinary plugin manager.
  withOptional(['tools'], (owner) => owner.get('tools').register({
    name: 'model_capability_detector_updates',
    description: 'Check the Model Capability Detector GitHub release or read its cached update status. Returns the stable version, release notes and fixed installation target; does not install packages.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'check'] } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (args?.action === 'status') return status()
      if (args?.action === 'check') return check(true)
      throw new Error('action must be status or check')
    },
  }))

  let timer
  const arm = () => {
    if (timer !== undefined || !background()) return
    timer = setTimeout(() => { void check().catch(() => {}) }, 10000)
    timer.unref?.()
  }
  ctx.effect(() => {
    arm()
    const off = store?.subscribe(arm)
    return () => { off?.(); clearTimeout(timer); lifetime.abort() }
  })
}
