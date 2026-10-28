/** Automatic capability detection for user-owned provider configurations. */
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { format } from 'node:util'

import { DEFAULT_CACHE_TTL_MS, loadCatalog, resolveName, toLookup } from './lib/catalog.js'
import { createDiagnostics, sanitizeMessage } from './lib/diagnostics.js'
import { configured, listingHeaders, listingUrl, readListing } from './lib/detect.js'
import { bridgeDiscovery, createDiscoveryCache, waitWithSignal } from './lib/discovery.js'
import { readJsonResponse } from './lib/http.js'
import {
  SAFE_CATALOG_FIELDS, RISKY_CATALOG_FIELDS, describeChanges, describeFallbacks,
  hasBlanks, mergeDetected, sameProviders,
} from './lib/plan.js'

export const name = 'model-capability-detector'
export const inject = ['settings', 'credentials']
export const DEFAULT_CONFIG = {
  settingsNs: 'llm-pi-ai',
  enabled: true,
  overwrite: false,
  dryRun: false,
  timeoutMs: 15000,
  debounceMs: 800,
  startupDelayMs: 3000,
  maxResponseBytes: 4 * 1024 * 1024,
  catalogFallback: true,
  catalogUrl: 'https://models.dev/api.json',
  catalogTimeoutMs: 30000,
  catalogMaxBytes: 16 * 1024 * 1024,
  catalogTtlMs: DEFAULT_CACHE_TTL_MS,
  catalogNumbers: true,
  catalogNumericStrategy: 'minimum',
  discoveryTrigger: true,
  logging: false,
  logFile: '',
}

function buildConfigSchema() {
  try {
    const z = createRequire(import.meta.url)('@deepseek-ai/schemastery').default
    return z.object({
      settingsNs: z.string().default('llm-pi-ai'),
      enabled: z.boolean().default(true),
      overwrite: z.boolean().default(false),
      dryRun: z.boolean().default(false),
      timeoutMs: z.number().min(1).max(600000).default(15000),
      debounceMs: z.number().min(0).max(60000).default(800),
      startupDelayMs: z.number().min(0).max(600000).default(3000),
      maxResponseBytes: z.number().min(1024).default(4 * 1024 * 1024),
      catalogFallback: z.boolean().default(true),
      catalogUrl: z.string().default('https://models.dev/api.json'),
      catalogTimeoutMs: z.number().min(1).max(600000).default(30000),
      catalogMaxBytes: z.number().min(1024).default(16 * 1024 * 1024),
      catalogTtlMs: z.number().min(0).default(DEFAULT_CACHE_TTL_MS),
      catalogNumbers: z.boolean().default(true),
      catalogNumericStrategy: z.union([z.const('minimum'), z.const('consensus')]).default('minimum'),
      discoveryTrigger: z.boolean().default(true),
      logging: z.boolean().default(false),
      logFile: z.string().default(''),
    })
  } catch {
    return undefined
  }
}
export const Config = buildConfigSchema()

/** One listing request, cancelled with its owner and bounded while streaming. */
async function fetchListing({ baseURL, api, apiKey, headers, timeoutMs, maxResponseBytes, signal }) {
  const target = listingUrl(baseURL, api)
  const controller = new AbortController()
  const relay = () => controller.abort(signal.reason)
  if (signal?.aborted) relay()
  else signal?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('model listing timed out')), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      headers: listingHeaders(target.family, apiKey, headers),
      signal: controller.signal,
      // Custom auth headers must never follow a redirect to another origin.
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      const hint = [401, 403].includes(response.status) ? '; check the API key' : ''
      throw new Error(`model listing answered ${response.status}${hint}`)
    }
    return readListing(await readJsonResponse(response, maxResponseBytes))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  if (config.enabled === false) return
  let disposed = false
  let timer
  let startupTimer
  let running = false
  let dirty = false
  let lastInspected
  let catalog
  let catalogLoadedAt = 0
  let catalogPending
  const lifetime = new AbortController()
  const discoveryCache = createDiscoveryCache()
  const homePath = ctx.get('dshHomePath')
  const logging = config.logging === true || (typeof config.logFile === 'string' && config.logFile.length > 0)
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => {
    if (logging) ctx.logger[level]('%s', sanitizeMessage(format(...args)))
  }]))
  const logPath = (() => {
    const path = config.logFile
    if (typeof path !== 'string' || path.length === 0) return undefined
    const home = typeof homePath === 'function' ? homePath() : undefined
    if (path === '~') return home
    if (/^~[/\\]/.test(path)) return home === undefined ? undefined : join(home, path.slice(2))
    return isAbsolute(path) || home === undefined ? path : join(home, path)
  })()
  const diagnostics = createDiagnostics(logPath)
  const note = (event, detail) => { if (diagnostics.enabled) void diagnostics.write(event, detail) }
  const catalogFields = config.catalogFallback === false ? [] : config.catalogNumbers === true
    ? [...SAFE_CATALOG_FIELDS, ...RISKY_CATALOG_FIELDS] : [...SAFE_CATALOG_FIELDS]

  const outsideTransaction = (operation) => {
    const store = ctx.get('hmr')?.executing
    return store?.getStore() === undefined || typeof store.exit !== 'function' ? operation() : store.exit(operation)
  }
  const resolveApiKey = async (profile) => {
    const ref = profile?.apiKeyEnv
    if (typeof ref !== 'string' || !ref) return undefined
    const resolved = await ctx.credentials.resolve(ref)
    if (typeof resolved?.value !== 'string' || !resolved.value.trim()) throw new Error('configured API credential is unavailable')
    return resolved.value.trim()
  }
  const readProfile = () => {
    try {
      const row = ctx.settings.describe().find((entry) => entry.ns === config.settingsNs)
      const providers = row?.user?.providers
      if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return undefined
      return { providers, revision: row.revision }
    } catch (error) {
      note('settings-unavailable', { message: sanitizeMessage(error) })
      logger.warn('model-capability-detector: settings unavailable: %s', sanitizeMessage(error))
      return undefined
    }
  }
  const ensureCatalog = async () => {
    if (disposed || config.catalogFallback === false || typeof homePath !== 'function') return undefined
    if (catalog !== undefined && Date.now() - catalogLoadedAt < config.catalogTtlMs) return catalog
    if (catalogPending !== undefined) return catalogPending
    catalogPending = (async () => {
      const loaded = await loadCatalog({
        homePath: homePath(), url: config.catalogUrl, ttlMs: config.catalogTtlMs,
        timeoutMs: config.catalogTimeoutMs, maxBytes: config.catalogMaxBytes, signal: lifetime.signal,
      })
      if (disposed) return undefined
      if (!loaded.ok) {
        note('catalog-failed', { reason: loaded.reason })
        logger.warn('model-capability-detector: catalog unavailable: %s', loaded.reason)
        return undefined
      }
      if (loaded.warning !== undefined) logger.warn('model-capability-detector: cached catalog: %s', loaded.warning)
      note('catalog-loaded', { source: loaded.source })
      catalog = toLookup(loaded.index)
      // Retry stale data on a later pass rather than treating it as fresh for a week.
      catalogLoadedAt = loaded.source === 'stale-cache' ? 0 : Date.now()
      return catalog
    })()
    try { return await catalogPending } finally { catalogPending = undefined }
  }
  const resolveCatalog = (lookup, id) => {
    const answer = resolveName(lookup, id, { numericStrategy: config.catalogNumericStrategy })
    if (answer.status !== 'resolved') note('catalog-miss', { model: id, status: answer.status })
    else {
      if (Object.keys(answer.withheld).length > 0) note('catalog-withheld', { model: id, withheld: answer.withheld })
      if (answer.numericDecisions !== undefined) note('catalog-numbers', { model: id, decisions: answer.numericDecisions })
    }
    return answer
  }
  // Only download a catalog if at least one eligible field is still missing
  // after considering the endpoint. API-complete listings need no public I/O.
  const needsCatalog = (providers, detected) => Object.entries(providers).some(([route, profile]) =>
    Array.isArray(profile?.models) && profile.models.some((model) =>
      typeof model?.id === 'string' && catalogFields.some((field) =>
        (config.overwrite === true || !configured(model[field])) && detected.get(route)?.get(model.id)?.[field] === undefined)))
  const enrich = async (providers, detected) => {
    const lookup = needsCatalog(providers, detected) ? await ensureCatalog() : undefined
    return mergeDetected(providers, detected, config.overwrite === true, {
      resolve: lookup === undefined ? undefined : (id) => resolveCatalog(lookup, id),
      allowedFields: catalogFields,
    })
  }
  const targetFor = async (profile) => ({
    baseURL: profile.baseURL.trim(), api: profile.api ?? 'openai-completions',
    apiKey: await resolveApiKey(profile), headers: profile.headers,
  })
  const readEndpoint = (target, signal = lifetime.signal) => fetchListing({
    ...target, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes, signal,
  })

  const discover = async (request, signal) => {
    const stored = readProfile()?.providers?.[request.provider]
    const api = request.api ?? stored?.api ?? 'openai-completions'
    const sameEndpoint = typeof stored?.baseURL === 'string'
      && stored.baseURL.trim().replace(/\/+$/, '') === request.baseURL.trim().replace(/\/+$/, '')
      && (stored.api ?? 'openai-completions') === api
    const explicitKey = request.apiKey?.trim()
    const headers = sameEndpoint ? { ...stored.headers } : undefined
    // An explicitly typed key takes precedence over saved authentication headers.
    if (explicitKey && headers !== undefined) {
      for (const header of Object.keys(headers)) {
        if (/^(authorization|x-api-key)$/i.test(header)) Reflect.deleteProperty(headers, header)
      }
    }
    const target = {
      baseURL: request.baseURL.trim(), api,
      apiKey: explicitKey || (sameEndpoint ? await resolveApiKey(stored) : undefined), headers,
    }
    const linked = AbortSignal.any([lifetime.signal, ...(signal === undefined ? [] : [signal])])
    const models = await readEndpoint(target, linked)
    linked.throwIfAborted()
    discoveryCache.put(target, models)
    const draft = { draft: { models: models.map(({ id }) => ({ id })) } }
    const detected = new Map([['draft', new Map(models.map((entry) => [entry.id, entry]))]])
    const result = await waitWithSignal(enrich(draft, detected), linked)
    linked.throwIfAborted()
    const merged = new Map(result.providers.draft.models.map((model) => [model.id, model]))
    note('models-discovered', { models: models.length })
    // A successful explicit refresh can disclose new fields even when the user
    // saves identical model rows. Invalidate the background signature, but wait
    // for a later save/reload event before considering a configuration write.
    lastInspected = undefined
    return models.map((model) => ({ ...model, ...merged.get(model.id) }))
  }
  if (config.discoveryTrigger !== false) {
    const install = (owner) => bridgeDiscovery(owner, {
      settingsNs: config.settingsNs, discover,
      onError: (error) => { note('discovery-failed', { message: sanitizeMessage(error) }); logger.warn('%s', sanitizeMessage(error)) },
    })
    if (typeof ctx.inject === 'function') ctx.inject(['llm'], install)
    else install(ctx)
  }

  const runOnce = async (reason) => {
    if (disposed) return
    note('pass-start', { reason })
    const current = readProfile()
    if (current === undefined) return
    const signature = JSON.stringify(current.providers)
    if (lastInspected === signature) return
    if (!hasBlanks(current.providers, config.overwrite === true)) { lastInspected = signature; return }
    const detected = new Map()
    let failed = false
    for (const [route, profile] of Object.entries(current.providers)) {
      if (disposed) return
      if (!Array.isArray(profile?.models) || !hasBlanks({ [route]: profile }, config.overwrite === true)) continue
      if (typeof profile.baseURL !== 'string' || !profile.baseURL.trim()) continue
      try {
        const target = await targetFor(profile)
        lifetime.signal.throwIfAborted()
        const cached = discoveryCache.get(target)
        const listing = cached ?? await readEndpoint(target)
        lifetime.signal.throwIfAborted()
        detected.set(route, new Map(listing.map((entry) => [entry.id, entry])))
        note('route-probed', { route, models: listing.length, cached: cached !== undefined })
      } catch (error) {
        if (disposed) return
        failed = true
        note('route-failed', { route, message: sanitizeMessage(error) })
        logger.warn('model-capability-detector: route "%s" failed: %s', route, sanitizeMessage(error))
      }
    }
    const { providers, changes, fallbacks } = await enrich(current.providers, detected)
    if (disposed) return
    if (changes.length === 0 || sameProviders(providers, current.providers)) {
      if (!failed) lastInspected = signature
      return
    }
    const report = describeChanges(changes).join('\n')
    const viaCatalog = describeFallbacks(fallbacks).join('\n')
    if (config.dryRun === true) {
      note('pass-dry-run', { changes: changes.length, plan: changes })
      logger.info('model-capability-detector: dry run, would set:\n%s\n%s', report, viaCatalog)
      return
    }
    // Network I/O can outlive a user edit. Even if a test/service accepts a stale
    // revision, do not replace model arrays computed from an outdated snapshot.
    const latest = readProfile()
    if (latest === undefined) return
    if (latest.revision !== current.revision || JSON.stringify(latest.providers) !== signature) {
      dirty = true
      return
    }
    lastInspected = failed ? undefined : JSON.stringify(providers)
    try {
      await outsideTransaction(() => ctx.settings.update(config.settingsNs, { providers }, current.revision))
      note('pass-written', { changes: changes.length, fallbacks: fallbacks.length })
      logger.info('model-capability-detector: detected capabilities:\n%s\n%s', report, viaCatalog)
    } catch (error) {
      lastInspected = undefined
      note('pass-write-refused', { message: sanitizeMessage(error) })
      logger.warn('model-capability-detector: write refused: %s', sanitizeMessage(error))
    }
  }
  const pump = async (reason) => {
    if (disposed) return
    if (running) { dirty = true; return }
    running = true
    try {
      do { dirty = false; await runOnce(reason) } while (dirty && !disposed)
    } finally { running = false }
  }
  const kick = (reason) => {
    if (disposed) return
    void Promise.resolve().then(() => outsideTransaction(() => pump(reason))).catch((error) => {
      if (disposed) return
      note('pass-failed', { message: sanitizeMessage(error) })
      logger.error('model-capability-detector: pass failed: %s', sanitizeMessage(error))
    })
  }
  const schedule = (reason) => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; kick(reason) }, config.debounceMs)
    timer.unref?.()
  }
  ctx.effect(() => () => {
    disposed = true
    clearTimeout(timer)
    clearTimeout(startupTimer)
    lifetime.abort(new Error('plugin disposed'))
    discoveryCache.clear()
  })
  ctx.on('settings/document-updated', (ns) => { if (ns === config.settingsNs) schedule('settings-document-updated') })
  ctx.on('app-boot/config-reload', () => schedule('config-reload'))
  const loader = ctx.root?.loader ?? ctx.get('loader')
  const settle = typeof loader?.await === 'function' ? Promise.resolve(loader.await()).catch(() => {}) : Promise.resolve()
  void settle.then(() => {
    if (disposed) return
    startupTimer = setTimeout(() => { startupTimer = undefined; kick('startup') }, config.startupDelayMs)
    startupTimer.unref?.()
  })
}
