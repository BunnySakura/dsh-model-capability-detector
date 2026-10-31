/** Update surface mounted independently from detector enablement. */
import { readFileSync } from 'node:fs'
import { createUpdateChecker } from './updates.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const UPDATE_PATH = '/api/model-capability-detector/updates'

export function registerUpdates(ctx, config) {
  const lifetime = new AbortController()
  const checker = createUpdateChecker({ currentVersion: VERSION, signal: lifetime.signal })
  const status = () => ({ ...checker.snapshot(), backgroundCheck: config.updateCheckOnStartup === true })
  const check = async (refresh = false) => ({ ...await checker.check({ refresh }), backgroundCheck: config.updateCheckOnStartup === true })
  const withOptional = (keys, callback) => {
    if (typeof ctx.inject === 'function') ctx.inject(keys, callback)
    else if (keys.every((key) => ctx.get(key))) callback(ctx)
  }
  withOptional(['connection'], (owner) => {
    owner.effect(() => owner.get('connection').fetch.register({
      path: UPDATE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        const reply = (value, code = 200) => Response.json(value, { status: code, headers: { 'cache-control': 'no-store' } })
        if (request.method === 'GET') return reply(status())
        if (Number(request.headers.get('content-length') ?? 0) > 1024) return reply({ reason: 'request-too-large' }, 413)
        let input
        try {
          const text = await request.text()
          if (text.length > 1024) return reply({ reason: 'request-too-large' }, 413)
          input = JSON.parse(text)
        } catch { return reply({ reason: 'invalid-request' }, 400) }
        if (input?.action !== 'check') return reply({ reason: 'read-only-update-endpoint' }, 400)
        return reply(await check(input.refresh === true))
      },
    }))
  })
  // The same read operation is available to an Agent. Installation confirmation
  // stays user-only; ordinary plugin_manager remains the authority for packages.
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
  ctx.effect(() => {
    if (config.updateCheckOnStartup === true) {
      timer = setTimeout(() => { void check().catch(() => {}) }, 10000)
      timer.unref?.()
    }
    return () => { clearTimeout(timer); lifetime.abort() }
  })
}
