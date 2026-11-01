/** Automatic capability detection for user-owned provider configurations. */
import { isAbsolute, join } from 'node:path'
import { format } from 'node:util'

import { loadCatalog, resolveName, toLookup } from './lib/catalog.js'
import { createDiagnostics, sanitizeMessage } from './lib/diagnostics.js'
import { configured, listingHeaders, listingUrl, readListing } from './lib/detect.js'
import { attachDiscovery, createDiscoveryCache, waitWithSignal } from './lib/discovery.js'
import { readJsonResponse } from './lib/http.js'
import { applyAlias } from './lib/names.js'
import { cleanEfforts, describePresets, presetEfforts } from './lib/presets.js'
import { probeModel } from './lib/probe.js'
import { createProvenance } from './lib/provenance.js'
import { DEFAULTS, createSettingsStore } from './lib/settings.js'
import { loadThirdParty } from './lib/sources.js'
import { rankOf, resolveTiered } from './lib/tiers.js'
import { registerUpdates } from './lib/update-host.js'
import {
  SAFE_CATALOG_FIELDS, RISKY_CATALOG_FIELDS, describeChanges, describeFallbacks,
  FIELDS, UPGRADE_BELOW_RANK, hasBlanks, hasUpgradable, mergeDetected, sameProviders,
} from './lib/plan.js'

export const name = 'model-capability-detector'
export const inject = ['settings', 'credentials']
/** Built-in defaults; the row's `config` and GUI overrides are layered on top. */
export const DEFAULT_CONFIG = DEFAULTS
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
  const homePath = ctx.get('dshHomePath')
  const home = typeof homePath === 'function' ? homePath() : undefined
  const settingsStore = createSettingsStore({
    home, patch: rawConfig,
    onInvalid: (keys) => ctx.logger?.warn?.('model-capability-detector: ignoring invalid configuration: %s', keys.join(', ')),
  })
  // Every option is read through this binding at the moment it is used, so a
  // change saved from the GUI applies without reloading the plugin.
  let config = settingsStore.effective()
  const detectorApi = {}
  if (typeof ctx.inject === 'function' || ctx.get('connection') || ctx.get('tools')) {
    registerUpdates(ctx, { config: () => config, settings: settingsStore, detector: detectorApi })
  }
  let disposed = false
  let timer
  let startupTimer
  let running = false
  let dirty = false
  let lastInspected
  let catalog
  let catalogLoadedAt = 0
  let catalogPending
  let thirdParty
  let thirdPartyLoadedAt = 0
  let thirdPartyPending
  const lifetime = new AbortController()
  const discoveryCache = createDiscoveryCache()
  const provenanceStore = createProvenance(home)
  let logging
  let logPath
  let diagnostics = createDiagnostics(undefined)
  let catalogFields
  const resolveLogPath = (path) => {
    if (typeof path !== 'string' || path.length === 0) return undefined
    if (path === '~') return home
    if (/^~[/\\]/.test(path)) return home === undefined ? undefined : join(home, path.slice(2))
    return isAbsolute(path) || home === undefined ? path : join(home, path)
  }
  const reconfigure = () => {
    logging = config.logging === true || (typeof config.logFile === 'string' && config.logFile.length > 0)
    const nextPath = resolveLogPath(config.logFile)
    if (nextPath !== logPath) {
      logPath = nextPath
      diagnostics = createDiagnostics(logPath)
    }
    catalogFields = config.catalogFallback === false ? [] : config.catalogNumbers === true
      ? [...SAFE_CATALOG_FIELDS, ...RISKY_CATALOG_FIELDS] : [...SAFE_CATALOG_FIELDS]
  }
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => {
    if (logging) ctx.logger[level]('%s', sanitizeMessage(format(...args)))
  }]))
  const note = (event, detail) => { if (diagnostics.enabled) void diagnostics.write(event, detail) }
  reconfigure()

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
  const ensureThirdParty = async () => {
    if (disposed || config.catalogFallback === false || config.thirdPartySources === false
      || config.catalogNumericStrategy !== 'official' || typeof homePath !== 'function') return undefined
    if (thirdParty !== undefined && Date.now() - thirdPartyLoadedAt < config.catalogTtlMs) return thirdParty
    if (thirdPartyPending !== undefined) return thirdPartyPending
    thirdPartyPending = (async () => {
      const loaded = await loadThirdParty({
        homePath: homePath(), ttlMs: config.catalogTtlMs, timeoutMs: config.catalogTimeoutMs, signal: lifetime.signal,
        urls: { openrouter: config.openrouterUrl, litellm: config.litellmUrl },
      })
      if (disposed) return undefined
      note('third-party-loaded', { status: loaded.status })
      if (Object.keys(loaded.lookups).length === 0) return undefined
      thirdParty = loaded.lookups
      // Retry a source that only answered from stale cache on a later pass.
      thirdPartyLoadedAt = Object.values(loaded.status).every((state) => state === 'network' || state === 'cache') ? Date.now() : 0
      return thirdParty
    })()
    try { return await thirdPartyPending } finally { thirdPartyPending = undefined }
  }
  const answerFor = (lookup, third, id) => (config.catalogNumericStrategy === 'official'
    ? resolveTiered(lookup, third, id, { aliases: config.modelAliases })
    : resolveName(lookup, applyAlias(config.modelAliases, id), { numericStrategy: config.catalogNumericStrategy }))
  const resolveCatalog = (lookup, third, id) => {
    const answer = answerFor(lookup, third, id)
    if (answer.status !== 'resolved') note('catalog-miss', { model: id, status: answer.status })
    else {
      if (Object.keys(answer.withheld).length > 0) note('catalog-withheld', { model: id, withheld: answer.withheld })
      if (answer.numericDecisions !== undefined) note('catalog-numbers', { model: id, decisions: answer.numericDecisions })
    }
    return answer
  }
  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const noReceipts = () => undefined
  /** Fields a catalog could still improve: blank, overwritten, or written earlier by a weaker source. */
  const wantedFor = (providers, detected, receiptFor) => {
    const wanted = []
    for (const [route, profile] of Object.entries(providers)) {
      if (!Array.isArray(profile?.models)) continue
      for (const model of profile.models) {
        if (typeof model?.id !== 'string') continue
        const fields = catalogFields.filter((field) => {
          if (detected.get(route)?.get(model.id)?.[field] !== undefined) return false
          if (config.overwrite === true || !configured(model[field])) return true
          if (config.upgradeWritten === false) return false
          const receipt = receiptFor(route, model.id, field)
          return receipt !== undefined && sameValue(receipt.value, model[field]) && rankOf(receipt.source) < UPGRADE_BELOW_RANK
        })
        if (fields.length > 0) wanted.push({ route, id: model.id, fields })
      }
    }
    return wanted
  }
  const enrich = async (providers, detected, receiptFor = noReceipts) => {
    const wanted = wantedFor(providers, detected, receiptFor)
    const lookup = wanted.length > 0 ? await ensureCatalog() : undefined
    let third
    if (wanted.length > 0 && config.catalogNumericStrategy === 'official' && config.thirdPartySources !== false) {
      // Third-party tables are fetched only when original records leave a wanted field open.
      const base = lookup ?? toLookup(undefined)
      const open = wanted.some(({ id, fields }) => {
        const answer = resolveTiered(base, undefined, id, { aliases: config.modelAliases })
        return fields.some((field) => answer.safe[field] === undefined && answer.withheld[field] === undefined)
      })
      if (open) third = await ensureThirdParty()
    }
    const presetId = config.reasoningPreset
    const presetValue = presetId === undefined || presetId === 'none' ? undefined : presetEfforts(presetId)
    return mergeDetected(providers, detected, config.overwrite === true, {
      resolve: config.catalogFallback === false ? undefined : lookup === undefined && config.catalogNumericStrategy !== 'official'
        ? undefined : (id) => resolveCatalog(lookup ?? toLookup(undefined), third, id),
      allowedFields: catalogFields,
      receiptFor, upgrade: config.upgradeWritten !== false,
      preset: presetValue === undefined ? undefined : { id: presetId, efforts: presetValue },
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
  // The Models-page bridge follows `discoveryTrigger` while the plugin runs.
  let llmOwner = typeof ctx.inject === 'function' ? undefined : ctx
  let detachBridge
  const syncBridge = () => {
    const wanted = !disposed && config.discoveryTrigger !== false && llmOwner !== undefined
    if (!wanted) { detachBridge?.(); detachBridge = undefined; return }
    if (detachBridge !== undefined) return
    const llm = llmOwner.get('llm')
    if (typeof llm?.discoverModels !== 'function' || typeof llm.listConfigurableProviders !== 'function') return
    detachBridge = attachDiscovery(llm, {
      settingsNs: () => config.settingsNs, discover, isActive: () => config.enabled !== false,
      onError: (error) => { note('discovery-failed', { message: sanitizeMessage(error) }); logger.warn('%s', sanitizeMessage(error)) },
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], (owner) => { llmOwner = owner; syncBridge(); return () => { detachBridge?.(); detachBridge = undefined; llmOwner = undefined } })
  } else syncBridge()

  const runOnce = async (reason) => {
    if (disposed || config.enabled === false) return
    note('pass-start', { reason })
    const current = readProfile()
    if (current === undefined) return
    const signature = JSON.stringify(current.providers)
    if (lastInspected === signature) return
    const receiptFor = await provenanceStore.load()
    const improvable = (providers) => hasBlanks(providers, config.overwrite === true)
      || (config.upgradeWritten !== false && hasUpgradable(providers, receiptFor))
    if (!improvable(current.providers)) { lastInspected = signature; return }
    const detected = new Map()
    let failed = false
    for (const [route, profile] of Object.entries(current.providers)) {
      if (disposed) return
      if (!Array.isArray(profile?.models) || !improvable({ [route]: profile })) continue
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
    const { providers, changes, fallbacks, provenance, upgrades } = await enrich(current.providers, detected, receiptFor)
    if (disposed) return
    if (changes.length === 0 || sameProviders(providers, current.providers)) {
      // Better evidence for an unchanged value only refreshes its receipt.
      if (provenance.length > 0 && config.dryRun !== true) await provenanceStore.record(provenance)
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
      await provenanceStore.record(provenance)
      note('pass-written', { changes: changes.length, fallbacks: fallbacks.length, upgrades })
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
    if (disposed || config.enabled === false) return
    clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; kick(reason) }, config.debounceMs)
    timer.unref?.()
  }
  // Read-only views for the settings page. None of them contacts a channel or
  // exposes an address, key or header.
  const TIER = {
    'channel-api': 'api', 'official-verified': 'official', 'original-provider-mirror': 'official',
    'official-sibling': 'sibling', 'third-party-consensus': 'third-party', 'api-hint': 'hint', 'legacy-catalog': 'legacy', preset: 'preset', manual: 'manual',
  }
  const tierOf = (source) => TIER[source?.kind] ?? 'unknown'
  const sourcesFor = async (needThird) => {
    const lookup = config.catalogFallback === false ? undefined : await ensureCatalog()
    const third = needThird ? await ensureThirdParty() : undefined
    return { lookup: lookup ?? toLookup(undefined), third }
  }
  const summarize = (answer, field) => (answer.safe?.[field] !== undefined
    ? { state: 'found', value: answer.safe[field], tier: tierOf(answer.sources?.[field] ?? { kind: 'legacy-catalog' }), match: answer.sources?.[field]?.match ?? answer.match }
    : {
      state: 'empty', reason: answer.reasons?.[field] ?? (answer.withheld?.[field] !== undefined ? 'withheld' : answer.reason ?? answer.status),
      // For a missing level set, whether the sources at least agree that the model reasons.
      ...field === 'reasoningEfforts' && answer.reasoningSupport !== undefined ? { support: answer.reasoningSupport.state } : {},
    })
  const buildReport = async () => {
    const current = readProfile()
    if (current === undefined) return { ok: false, reason: 'settings-unavailable' }
    const receiptFor = await provenanceStore.load()
    const blank = Object.values(current.providers).some((profile) => Array.isArray(profile?.models)
      && profile.models.some((model) => typeof model?.id === 'string' && FIELDS.some((field) => !configured(model[field]))))
    const { lookup, third } = blank ? await sourcesFor(config.thirdPartySources !== false) : { lookup: toLookup(undefined), third: undefined }
    const routes = []
    for (const [route, profile] of Object.entries(current.providers)) {
      if (!Array.isArray(profile?.models)) continue
      const models = []
      for (const model of profile.models) {
        if (typeof model?.id !== 'string') continue
        const answer = FIELDS.some((field) => !configured(model[field])) ? answerFor(lookup, third, model.id) : undefined
        const fields = {}
        for (const field of FIELDS) {
          if (configured(model[field])) {
            const receipt = receiptFor(route, model.id, field)
            const written = receipt !== undefined && sameValue(receipt.value, model[field])
            fields[field] = { state: 'set', value: model[field], tier: written ? tierOf(receipt.source) : 'manual' }
          } else if (config.catalogFallback === false) fields[field] = { state: 'empty', reason: 'catalog-disabled' }
          else if (!catalogFields.includes(field)) fields[field] = { state: 'empty', reason: 'field-disabled' }
          else fields[field] = summarize(answer, field)
        }
        models.push({ id: model.id, matched: answer?.status === 'resolved' ? answer.identity ?? true : answer === undefined ? undefined : false, fields })
      }
      routes.push({ route, api: profile.api ?? 'openai-completions', models })
    }
    return {
      ok: true, generatedAt: new Date().toISOString(), strategy: config.catalogNumericStrategy, routes,
      probeEnabled: config.probeEnabled === true, preset: config.reasoningPreset ?? 'none', presets: describePresets(),
    }
  }
  const lookupModel = async (model) => {
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 200) return { ok: false, reason: 'invalid-model' }
    const { lookup, third } = await sourcesFor(config.thirdPartySources !== false)
    const answer = answerFor(lookup, third, model.trim())
    const fields = Object.fromEntries(FIELDS.map((field) => [field, summarize(answer, field)]))
    return {
      ok: true, model: model.trim(), status: answer.status, match: answer.match, aliased: answer.aliased === true,
      identity: answer.identity, reason: answer.status === 'resolved' ? undefined : answer.reason, fields, votes: answer.votes ?? {},
    }
  }
  const rescan = async () => {
    if (disposed || config.enabled === false) return { ok: false, reason: 'disabled' }
    lastInspected = undefined
    try { await outsideTransaction(() => pump('manual-rescan')) } catch { return { ok: false, reason: 'failed' } }
    return { ok: true }
  }
  /** Write a reasoning dictionary onto one blank model row, on the user's request. */
  const applyReasoning = async ({ route, model, preset, efforts }) => {
    if (disposed || config.enabled === false) return { ok: false, reason: 'disabled' }
    if (config.dryRun === true) return { ok: false, reason: 'dry-run' }
    if (typeof route !== 'string' || typeof model !== 'string' || route.length === 0 || model.length === 0 || route.length > 200 || model.length > 200) {
      return { ok: false, reason: 'invalid-request' }
    }
    if (preset !== undefined && presetEfforts(preset) === undefined) return { ok: false, reason: 'unknown-preset' }
    const value = preset !== undefined ? presetEfforts(preset) : cleanEfforts(efforts)
    if (value === undefined) return { ok: false, reason: 'invalid-request' }
    const current = readProfile()
    if (current === undefined) return { ok: false, reason: 'settings-unavailable' }
    const profile = Object.hasOwn(current.providers, route) ? current.providers[route] : undefined
    const index = Array.isArray(profile?.models) ? profile.models.findIndex((entry) => entry?.id === model) : -1
    if (index < 0) return { ok: false, reason: 'not-found' }
    if (configured(profile.models[index].reasoningEfforts)) return { ok: false, reason: 'already-set' }
    const providers = {
      ...current.providers,
      [route]: { ...profile, models: profile.models.map((entry, position) => (position === index ? { ...entry, reasoningEfforts: value } : entry)) },
    }
    try {
      await outsideTransaction(() => ctx.settings.update(config.settingsNs, { providers }, current.revision))
    } catch (error) {
      note('apply-refused', { message: sanitizeMessage(error) })
      return { ok: false, reason: 'refused' }
    }
    // A choice made by hand is the user's: the receipt keeps later passes from replacing it.
    await provenanceStore.record([{ route, model, field: 'reasoningEfforts', value, source: { kind: 'manual' } }])
    lastInspected = undefined
    note('apply-reasoning', { preset: preset ?? 'custom' })
    return { ok: true, efforts: value }
  }
  let probing = false
  /** Ask one channel which reasoning levels it accepts. Off unless `probeEnabled`. */
  const probeChannel = async ({ route, model }) => {
    if (disposed || config.enabled === false) return { ok: false, reason: 'disabled' }
    if (config.probeEnabled !== true) return { ok: false, reason: 'probe-disabled' }
    if (typeof route !== 'string' || typeof model !== 'string' || route.length === 0 || model.length === 0 || route.length > 200 || model.length > 200) {
      return { ok: false, reason: 'invalid-request' }
    }
    if (probing) return { ok: false, reason: 'busy' }
    const current = readProfile()
    if (current === undefined) return { ok: false, reason: 'settings-unavailable' }
    const profile = Object.hasOwn(current.providers, route) ? current.providers[route] : undefined
    if (!Array.isArray(profile?.models) || !profile.models.some((entry) => entry?.id === model)) return { ok: false, reason: 'not-found' }
    if ((profile.api ?? 'openai-completions') !== 'openai-completions') return { ok: false, reason: 'unsupported-api' }
    if (typeof profile.baseURL !== 'string' || !profile.baseURL.trim()) return { ok: false, reason: 'invalid-request' }
    probing = true
    try {
      const target = await targetFor(profile)
      const result = await probeModel({
        baseURL: target.baseURL, apiKey: target.apiKey, headers: target.headers, model,
        timeoutMs: config.timeoutMs, signal: lifetime.signal,
      })
      // Counts and verdicts only: no route, model, address or response text.
      note('probe-done', { ok: result.ok, verdict: result.verdict, reason: result.reason, requests: result.requests })
      return result
    } catch (error) {
      note('probe-failed', { message: sanitizeMessage(error) })
      return { ok: false, reason: 'failed' }
    } finally { probing = false }
  }
  detectorApi.report = buildReport
  detectorApi.lookup = lookupModel
  detectorApi.rescan = rescan
  detectorApi.applyReasoning = applyReasoning
  detectorApi.probe = probeChannel
  ctx.effect(() => () => {
    disposed = true
    clearTimeout(timer)
    clearTimeout(startupTimer)
    lifetime.abort(new Error('plugin disposed'))
    discoveryCache.clear()
    detachBridge?.()
    detachBridge = undefined
  })
  // A change saved from the GUI: refresh derived state, drop caches that
  // depended on the old values, and look at the saved providers once again.
  ctx.effect(() => settingsStore.subscribe((next, previous) => {
    if (disposed) return
    config = next
    reconfigure()
    if (next.catalogUrl !== previous.catalogUrl || next.catalogTtlMs !== previous.catalogTtlMs) {
      catalog = undefined
      catalogLoadedAt = 0
    }
    if (next.openrouterUrl !== previous.openrouterUrl || next.litellmUrl !== previous.litellmUrl
      || next.catalogTtlMs !== previous.catalogTtlMs) {
      thirdParty = undefined
      thirdPartyLoadedAt = 0
    }
    lastInspected = undefined
    syncBridge()
    note('settings-changed', { changed: Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(previous[key])) })
    schedule('settings-changed')
  }))
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
