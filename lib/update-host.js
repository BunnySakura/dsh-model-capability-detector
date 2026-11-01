/** Host API mounted independently from detector enablement: settings, update check and the read-only Agent tool. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePresets } from './presets.js'
import { createUpdateChecker } from './updates.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Whether this copy runs from a development checkout instead of an installed package.
 * A profile can link the plugin to a working directory (`link:` dependency); the
 * plugin manager then replaces that directory through the link, which fails on
 * Windows and can delete files of the checkout. Node resolves the link, so an
 * installed copy always sits under `node_modules` and carries no `.git`.
 */
export const isDevCheckout = (root = ROOT) => !/[\\/]node_modules[\\/]/.test(root) || existsSync(join(root, '.git'))
export const UPDATE_PATH = '/api/model-capability-detector/updates'
export const SETTINGS_PATH = '/api/model-capability-detector/settings'
export const DETECTOR_PATH = '/api/model-capability-detector/detector'
/** A custom header forces a CORS preflight, so a foreign page cannot write settings. */
export const WRITE_HEADER = 'x-model-capability-detector'
const MAX_BODY = 16 * 1024

const reply = (value, code = 200) => Response.json(value, { status: code, headers: { 'cache-control': 'no-store' } })

const REASON_STATUS = {
  'invalid-request': 400, 'unknown-preset': 400, 'unsupported-api': 400,
  'probe-disabled': 403, 'not-found': 404,
  'already-set': 409, busy: 409, 'dry-run': 409, disabled: 409, refused: 409,
  'settings-unavailable': 503,
}
/** HTTP status for an action result; a probe that reached the channel but failed is a bad gateway. */
const statusOf = (result) => (result?.ok === true ? 200 : REASON_STATUS[result?.reason] ?? 502)

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
  const linked = options.linked ?? isDevCheckout()
  const status = () => ({ ...checker.snapshot(), backgroundCheck: background(), linked })
  const check = async (refresh = false) => ({ ...await checker.check({ refresh }), backgroundCheck: background(), linked })
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
    const detector = options.detector
    if (detector !== undefined) {
      // GET reads the detection report; POST runs a lookup or a rescan. Neither
      // contacts a channel for the report or lookup, and neither returns addresses or keys.
      owner.effect(() => connection.fetch.register({
        path: DETECTOR_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
        async fetch(request) {
          if (typeof detector.report !== 'function') return reply({ ok: false, reason: 'unavailable' }, 503)
          if (request.method === 'GET') return reply(await detector.report())
          const body = await readJson(request)
          if (body.error !== undefined) return reply({ ok: false, reason: 'invalid-request' }, body.error)
          if (body.value?.action === 'lookup') {
            const result = await detector.lookup(body.value.model)
            return reply(result, result.ok ? 200 : 400)
          }
          if (body.value?.action === 'rescan') return reply(await detector.rescan())
          // Both actions pass only these named fields on, never the raw request body.
          const { route, model, preset, efforts } = body.value ?? {}
          if (body.value?.action === 'apply-reasoning' && typeof detector.applyReasoning === 'function') {
            const result = await detector.applyReasoning({ route, model, preset, efforts })
            return reply(result, statusOf(result))
          }
          if (body.value?.action === 'probe' && typeof detector.probe === 'function') {
            const result = await detector.probe({ route, model })
            return reply(result, statusOf(result))
          }
          return reply({ ok: false, reason: 'unknown-action' }, 400)
        },
      }))
    }
    if (store === undefined) return
    owner.effect(() => connection.fetch.register({
      path: SETTINGS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') return reply({ ok: true, version: VERSION, presets: describePresets(), ...store.refresh() })
        const body = await readJson(request)
        if (body.error !== undefined) return reply({ ok: false, reason: 'invalid-request' }, body.error)
        const result = await store.update(body.value)
        if (result.ok) return reply({ ok: true, version: VERSION, presets: describePresets(), ...result.snapshot })
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
