/** Optional bridge for the Models page's draft discovery operation.
 *
 * DSH currently exposes neither a discovery event nor a metadata middleware.
 * Wrap only the public method, never the registry or transport. Cleanup restores
 * its descriptor when still owned; a wrapper retained by another plugin becomes
 * a pass-through after disposal. No credentials or response bodies are cached.
 */
import { createHash } from 'node:crypto'

const TTL_MS = 5 * 60 * 1000
const MAX_ENTRIES = 8

function targetKey({ baseURL, api, apiKey, headers }) {
  return createHash('sha256').update(JSON.stringify([
    baseURL, api, apiKey ?? '', Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest('hex')
}

/** Stop waiting promptly while a shared catalog refresh may keep running. */
export function waitWithSignal(operation, signal) {
  if (signal === undefined) return operation
  if (signal.aborted) {
    // Observe the operation even when cancellation won the race.
    void Promise.resolve(operation).catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createDiscoveryCache() {
  const entries = new Map()
  return {
    put(target, models) {
      const now = Date.now()
      for (const [key, entry] of entries) if (now - entry.at >= TTL_MS) entries.delete(key)
      const key = targetKey(target)
      entries.delete(key)
      entries.set(key, { at: now, models: structuredClone(models) })
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
    },
    get(target) {
      const key = targetKey(target)
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (Date.now() - entry.at >= TTL_MS) {
        entries.delete(key)
        return undefined
      }
      return structuredClone(entry.models)
    },
    clear() { entries.clear() },
  }
}

/** Install a reversible wrapper; keep discovery of built-in providers intact. */
export function bridgeDiscovery(ctx, { settingsNs, discover, onError }) {
  const llm = ctx.get('llm')
  if (typeof llm?.discoverModels !== 'function' || typeof llm.listConfigurableProviders !== 'function') return
  ctx.effect(() => {
    let active = true
    const descriptor = Object.getOwnPropertyDescriptor(llm, 'discoverModels')
    let method = descriptor
    for (let proto = Object.getPrototypeOf(llm); method === undefined && proto !== null; proto = Object.getPrototypeOf(proto)) {
      method = Object.getOwnPropertyDescriptor(proto, 'discoverModels')
    }
    // Cordis returns a fresh context-tracing function proxy on every method get.
    // Read the descriptor so forwarding preserves the actual caller's context
    // and cleanup can compare our registration without comparing proxy objects.
    const original = method?.value
    if (typeof original !== 'function') return () => {}
    const wrapped = async function (ns, request, signal) {
      if (!active || ns !== settingsNs || signal?.aborted) {
        return original.call(this, ns, request, signal)
      }
      const provider = llm.listConfigurableProviders().find((entry) =>
        entry.settingsNs === ns && entry.provider === request?.provider)
      // Only custom routes with an explicit endpoint can be probed reliably.
      if ((provider !== undefined && provider.declared !== true) || typeof request?.baseURL !== 'string' || !request.baseURL.trim()) {
        return original.call(this, ns, request, signal)
      }
      try {
        const models = await discover(request, signal)
        signal?.throwIfAborted()
        return models.map(({ id, name, contextWindow, maxTokens, input }) => ({
          id,
          ...(name === undefined ? {} : { name }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(input === undefined ? {} : { inputModalities: [...input] }),
        }))
      } catch (error) {
        onError(error)
        // Do not repeat failed/cancelled requests or retain their credentials.
        throw new Error('Model capability discovery failed; check endpoint, credentials and connectivity')
      }
    }
    Object.defineProperty(llm, 'discoverModels', { value: wrapped, writable: true, configurable: true })
    return () => {
      active = false
      if (Object.getOwnPropertyDescriptor(llm, 'discoverModels')?.value !== wrapped) return
      if (descriptor === undefined) Reflect.deleteProperty(llm, 'discoverModels')
      else Object.defineProperty(llm, 'discoverModels', descriptor)
    }
  })
}
