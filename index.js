/**
 * Model capability detection for imported provider profiles.
 *
 * Saving a provider on the Models page writes it into the profile patch and the
 * settings service emits `settings/document-updated`. This plugin listens for
 * that, interrogates the provider's model listing (`GET {baseURL}/models`), and
 * writes the detected capabilities back into the same profile entry: context
 * window, output cap, image input, and reasoning levels.
 *
 * Many resale gateways answer `/models` with nothing but an id, so a public
 * catalog answers the fields the endpoint left empty — but only the fields whose
 * cross-provider agreement is high enough to trust, and only when every catalog
 * entry for that name agrees. See `lib/catalog.js` for the measurements.
 *
 * A capability that no source discloses stays untouched rather than guessed: a
 * wrong `contextWindow` silently truncates conversations.
 *
 * @module dsh-model-capability-detector
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

import {
  DEFAULT_CACHE_TTL_MS,
  loadCatalog,
  resolveName,
  toLookup,
} from './lib/catalog.js'
import { createDiagnostics } from './lib/diagnostics.js'
import { configured, listingHeaders, listingUrl, readListing } from './lib/detect.js'
import {
  FIELDS,
  RISKY_CATALOG_FIELDS,
  SAFE_CATALOG_FIELDS,
  describeChanges,
  describeFallbacks,
  hasBlanks,
  mergeDetected,
  sameProviders,
} from './lib/plan.js'

export const name = 'model-capability-detector'
export const inject = ['settings', 'credentials']

/** Deployment-tunable row values; the profile patch layer carries them. */
export const DEFAULT_CONFIG = {  /** Profile entry id of the LLM adapter whose `providers` this plugin fills. */
  settingsNs: 'llm-pi-ai',
  /** Master switch for the automatic pass. */
  enabled: true,
  /** Replace values the user already set instead of only filling blanks. */
  overwrite: false,
  /** Probe and log the plan without writing the profile. */
  dryRun: false,
  /** Per-endpoint listing timeout, in milliseconds. */
  timeoutMs: 15000,
  /** Quiet period after a settings change before probing, in milliseconds. */
  debounceMs: 800,
  /** Delay before the pass that covers profiles imported while this plugin was off. */
  startupDelayMs: 3000,
  /** Largest listing body accepted, in bytes. */
  maxResponseBytes: 4 * 1024 * 1024,
  /** Consult the public catalog when an endpoint discloses nothing. */
  catalogFallback: true,
  /** Public catalog URL. */
  catalogUrl: 'https://models.dev/api.json',
  /** Catalog download timeout, in milliseconds. */
  catalogTimeoutMs: 30000,
  /** Largest catalog accepted, in bytes. */
  catalogMaxBytes: 16 * 1024 * 1024,
  /** How long a cached catalog stays usable. */
  catalogTtlMs: DEFAULT_CACHE_TTL_MS,
  /** Also take `contextWindow` and `maxTokens` from the catalog. */
  catalogNumbers: false,
  /** Absolute diagnostics log path; empty disables the log. */
  logFile: '',
}

/**
 * The row's Config schema, when schemastery is resolvable.
 *
 * Declaring a schema makes `Config.listConfigs` describe the accepted fields
 * instead of reporting `absent`. It is optional on purpose: schemastery is a
 * peer this plugin cannot assume — a profile may install the plugin without it —
 * and an `import` that throws at load time would take the whole plugin down.
 * Config handling already defaults every field, so a missing schema costs the
 * Settings page its form, not the plugin its behaviour.
 * @returns the schema, or `undefined` when schemastery is unavailable.
 */
let configSchema
function buildConfigSchema() {
  if (configSchema !== undefined) return configSchema
  let z
  try {
    z = createRequire(import.meta.url)('@deepseek-ai/schemastery').default
  } catch {
    configSchema = null
    return null
  }
  try {
    configSchema = z.object({
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
      catalogNumbers: z.boolean().default(false),
      logFile: z.string().default(''),
    })
  } catch {
    configSchema = null
  }
  return configSchema
}

/**
 * The schema export the Loader reads.
 *
 * The Loader inspects the module's `Config` export before `apply` runs, so it
 * must be a value rather than a getter that might throw. An absent schema is a
 * supported state, which is why an unresolvable schemastery yields `undefined`
 * here instead of an exception.
 */
export const Config = buildConfigSchema() ?? undefined

/** Message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Interrogate one endpoint for the models it advertises.
 * @param options - listing target, one-shot credential, and limits.
 * @returns the detected capabilities, in endpoint order.
 */
async function fetchListing(options) {
  const { baseURL, api, apiKey, headers, timeoutMs, maxResponseBytes } = options
  const target = listingUrl(baseURL, api)
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`model listing timed out after ${timeoutMs} ms`)),
    timeoutMs,
  )
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      headers: listingHeaders(target.family, apiKey, headers),
      signal: controller.signal,
    })
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '; check the API key' : ''
      throw new Error(`${target.url} answered ${response.status}${hint}`)
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      throw new Error(`${target.url} declares more than ${maxResponseBytes} bytes`)
    }
    const text = await response.text()
    if (text.length > maxResponseBytes) {
      throw new Error(`${target.url} answered with more than ${maxResponseBytes} bytes`)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${target.url} did not answer with JSON`)
    }
    return readListing(body)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Detect capabilities for provider profiles and write them into the same
 * profile entry, triggered by configuration changes.
 * @param ctx - registrant context carrying settings and credentials.
 * @param rawConfig - the row's patch config, merged over {@link DEFAULT_CONFIG}.
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  if (config.enabled === false) return
  let timer
  let running = false
  let dirty = false
  /**
   * Serialized `providers` already interrogated, covering both an answered value
   * and the value this plugin itself just wrote.
   */
  let lastInspected
  /** Rehydrated catalog index, loaded at most once per plugin lifetime. */
  let catalog

  const homePath = ctx.get('dshHomePath')
  /**
   * Resolve a configured log path.
   *
   * A leading `~/` is expanded here rather than relying on the caller, because
   * the configuration value reaches the filesystem API unexpanded. A relative
   * path resolves against the harness home so the log has one predictable home
   * instead of depending on the process working directory.
   */
  const resolveLogPath = () => {
    const configuredPath = config.logFile
    if (typeof configuredPath !== 'string' || configuredPath.length === 0) return undefined
    const home = typeof homePath === 'function' ? homePath() : undefined
    if (configuredPath === '~') return home
    if (configuredPath.startsWith('~/') || configuredPath.startsWith('~\\')) {
      return home === undefined ? undefined : join(home, configuredPath.slice(2))
    }
    if (home !== undefined && !/^[A-Za-z]:|^\//.test(configuredPath)) {
      return join(home, configuredPath)
    }
    return configuredPath
  }
  const logPath = resolveLogPath()
  const diagnostics = createDiagnostics(logPath)

  /** Record one diagnostic event, and mirror it to the Host logger. */
  const note = (event, detail) => {
    if (diagnostics.enabled) void diagnostics.write(event, detail)
  }

  /** Fields the catalog may contribute under the current configuration. */
  const catalogFields = () =>
    config.catalogFallback === false
      ? []
      : config.catalogNumbers === true
        ? [...SAFE_CATALOG_FIELDS, ...RISKY_CATALOG_FIELDS]
        : [...SAFE_CATALOG_FIELDS]

  /**
   * Run `operation` with the HMR transaction scope left behind.
   *
   * `apply` itself may run inside `hmr.runExclusive` — the Loader activates a
   * plugin through it, and `app-boot/config-reload` is published from there too —
   * so every timer and promise this plugin creates inherits the transaction
   * marker. The write reaches `configEditor.edit`, which calls `runExclusive`
   * again and rejects the nested transaction. `AsyncLocalStorage.exit` is the one
   * documented way out: it runs the callback with no store, and the promise it
   * creates inherits that empty scope. Falls back to a plain call when the HMR
   * service is absent, where no transaction can be active.
   * @param operation - work that must not appear to run inside a transaction.
   * @returns the operation's result.
   */
  const outsideTransaction = (operation) => {
    const hmr = ctx.get('hmr')
    const store = hmr?.executing
    if (store === undefined || typeof store.exit !== 'function' || store.getStore() === undefined) {
      return operation()
    }
    return store.exit(operation)
  }

  /** Resolve one route's one-shot probe credential. */
  const resolveApiKey = async (profile) => {
    const ref = profile?.apiKeyEnv
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    const resolved = await ctx.credentials.resolve(ref)
    return resolved?.value
  }

  /**
   * Read the `providers` value this profile owns, plus the settings revision.
   *
   * Only the profile's own layer qualifies: `settings.update` merges into that
   * layer, so filling a route an installed bundle declares would freeze a copy
   * of it and hide later bundle updates. A profile that inherits every route is
   * left alone — importing a provider on the Models page writes the user layer.
   * @returns the providers to inspect, or `undefined` when the layer has none.
   */
  const readProfile = () => {
    let rows
    try {
      rows = ctx.settings.describe()
    } catch (error) {
      const message = messageOf(error)
      note('settings-unavailable', { message })
      ctx.logger.warn('model-capability-detector: settings are unavailable: %s', message)
      return undefined
    }
    const row = rows.find((entry) => entry.ns === config.settingsNs)
    if (row === undefined) {
      note('no-settings-entry', { settingsNs: config.settingsNs })
      ctx.logger.debug(
        'model-capability-detector: no "%s" entry in this profile',
        config.settingsNs,
      )
      return undefined
    }
    const providers = row.user?.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
      note('no-user-providers', { settingsNs: config.settingsNs })
      ctx.logger.debug(
        'model-capability-detector: entry "%s" declares no providers in this profile layer; inherited routes are left to the bundle that declares them',
        config.settingsNs,
      )
      return undefined
    }
    return { providers, revision: row.revision }
  }

  /**
   * Discover endpoint capabilities for every route that names one.
   * @param providers - the profile's own `providers` value.
   * @returns capabilities per route, and whether any route failed to answer.
   */
  const detect = async (providers) => {
    const byRoute = new Map()
    let failed = false
    for (const [route, profile] of Object.entries(providers)) {
      if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) continue
      if (!Array.isArray(profile.models) || profile.models.length === 0) continue
      const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
      if (baseURL.length === 0) {
        note('route-skipped', { route, reason: 'no baseURL' })
        ctx.logger.debug('model-capability-detector: route "%s" names no baseURL; skipped', route)
        continue
      }
      try {
        const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
        const apiKey = await resolveApiKey(profile)
        const listing = await fetchListing({
          baseURL,
          api,
          apiKey,
          headers: profile.headers,
          timeoutMs: config.timeoutMs,
          maxResponseBytes: config.maxResponseBytes,
        })
        byRoute.set(route, new Map(listing.map((capabilities) => [capabilities.id, capabilities])))
        const disclosed = listing.filter(
          (entry) =>
            entry.contextWindow !== undefined ||
            entry.input !== undefined ||
            entry.reasoningEfforts !== undefined,
        ).length
        note('route-probed', { route, models: listing.length, disclosed })
        ctx.logger.debug(
          'model-capability-detector: route "%s" advertised %d models (%d with capabilities)',
          route,
          listing.length,
          disclosed,
        )
      } catch (error) {
        failed = true
        const message = messageOf(error)
        note('route-failed', { route, message })
        ctx.logger.warn(
          'model-capability-detector: route "%s" could not be interrogated: %s',
          route,
          message,
        )
      }
    }
    return { byRoute, failed }
  }

  /**
   * Load the public catalog once, if the configuration permits it.
   * @returns the rehydrated lookup, or `undefined` when unavailable.
   */
  const ensureCatalog = async () => {
    if (config.catalogFallback === false) return undefined
    if (catalog !== undefined) return catalog
    if (typeof homePath !== 'function') {
      note('catalog-unavailable', { reason: 'the harness home path service is absent' })
      return undefined
    }
    const loaded = await loadCatalog({
      homePath: homePath(),
      url: config.catalogUrl,
      ttlMs: config.catalogTtlMs,
      timeoutMs: config.catalogTimeoutMs,
      maxBytes: config.catalogMaxBytes,
    })
    if (!loaded.ok) {
      note('catalog-failed', { reason: loaded.reason })
      ctx.logger.warn('model-capability-detector: catalog unavailable: %s', loaded.reason)
      return undefined
    }
    if (loaded.warning !== undefined) {
      note('catalog-stale', { reason: loaded.warning })
      ctx.logger.warn(
        'model-capability-detector: using the cached catalog because %s',
        loaded.warning,
      )
    }
    note('catalog-loaded', {
      source: loaded.source,
      cache: join('cache', 'model-capability-detector', 'catalog.json'),
    })
    const lookup = toLookup(loaded.index)
    catalog = { lookup, counted: 0, withheld: 0 }
    return catalog
  }

  /**
   * Write through the settings service, detached from any ambient HMR scope.
   *
   * `settings.update` reaches `configEditor.edit`, which runs inside
   * `hmr.runExclusive`; a settings change reported while the Loader is already
   * reconciling a patch would otherwise inherit that async scope and be refused
   * as a nested HMR transaction.
   * @param providers - the complete `providers` value to merge in.
   * @param revision - the settings revision the value was read at.
   */
  const writeProfile = (providers, revision) =>
    outsideTransaction(() => ctx.settings.update(config.settingsNs, { providers }, revision))

  /** One detection pass over the configured namespace. */
  const runOnce = async (reason) => {
    note('pass-start', { reason })
    const current = readProfile()
    if (current === undefined) return
    const signature = JSON.stringify(current.providers)
    // One signature covers both cases: a value already answered (whether by a
    // catalog lookup or by this plugin's own write) needs no second probe. The
    // signature is recorded as the value about to be written, so the document
    // event announcing that write matches here and stops the echo.
    if (lastInspected === signature) {
      note('pass-skip', { reason: 'value already inspected' })
      ctx.logger.debug('model-capability-detector: this value was already inspected')
      return
    }
    if (!hasBlanks(current.providers, config.overwrite === true)) {
      lastInspected = signature
      note('pass-skip', { reason: 'every model is described' })
      ctx.logger.debug('model-capability-detector: every model is described after "%s"', reason)
      return
    }

    const { byRoute: detected, failed } = await detect(current.providers)
    const allowed = catalogFields()
    let resolve
    if (allowed.length > 0) {
      const loaded = await ensureCatalog()
      if (loaded !== undefined) {
        resolve = (id) => {
          const answer = resolveName(loaded.lookup, id)
          if (answer.status === 'resolved') {
            if (Object.keys(answer.safe).length > 0) loaded.counted += 1
            if (Object.keys(answer.withheld).length > 0) {
              loaded.withheld += 1
              note('catalog-withheld', {
                model: id,
                identity: answer.identity,
                withheld: answer.withheld,
              })
            }
          } else {
            note('catalog-miss', { model: id, status: answer.status, reason: answer.reason })
          }
          return answer
        }
      }
    }

    // A pass that could interrogate nothing new is not worth marking stable: a
    // failed endpoint should be retried on the next change or reload.
    if (detected.size === 0 && resolve === undefined) return

    const { providers, changes, fallbacks } = mergeDetected(
      current.providers,
      detected,
      config.overwrite === true,
      { resolve, allowedFields: allowed },
    )
    if (changes.length === 0 || sameProviders(providers, current.providers)) {
      // The value is fully answered as far as every allowed source knows, so
      // re-inspecting it would only repeat the same lookups.
      if (!failed) lastInspected = signature
      note('pass-nothing-to-fill', { reason })
      ctx.logger.debug('model-capability-detector: nothing to fill after "%s"', reason)
      return
    }
    const report = describeChanges(changes).join('\n')
    const viaCatalog = describeFallbacks(fallbacks)
    if (config.dryRun === true) {
      note('pass-dry-run', { reason, changes: changes.length, plan: changes })
      ctx.logger.info(
        'model-capability-detector: dry run after "%s", would set:\n%s%s',
        reason,
        report,
        viaCatalog.length === 0 ? '' : `\nfrom catalog:\n${viaCatalog.join('\n')}`,
      )
      return
    }

    // Record the value about to be written, not the one just inspected: the
    // document event announcing this write carries the new value, and matching
    // it is what stops the echo from triggering another probe.
    lastInspected = JSON.stringify(providers)
    try {
      await writeProfile(providers, current.revision)
      note('pass-written', { reason, changes: changes.length, fallbacks: fallbacks.length })
      ctx.logger.info(
        'model-capability-detector: detected capabilities:\n%s%s',
        report,
        viaCatalog.length === 0 ? '' : `\nfrom catalog:\n${viaCatalog.join('\n')}`,
      )
    } catch (error) {
      // The write was refused, so the recorded signature no longer describes the
      // document; clear it so the next event re-probes the actual value.
      lastInspected = undefined
      const message = messageOf(error)
      note('pass-write-refused', { message })
      // A concurrent edit makes the revision stale; the resulting document event
      // schedules another pass against the fresh value.
      ctx.logger.warn('model-capability-detector: write refused: %s', message)
    }
  }

  /** Serialize passes; a change that lands mid-pass schedules one more. */
  const pump = async (reason) => {
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      do {
        dirty = false
        await runOnce(reason)
      } while (dirty)
    } finally {
      running = false
    }
  }

  /** Run one pass without letting a rejection escape as an unhandled one. */
  const kick = (reason) => {
    void Promise.resolve()
      .then(() => outsideTransaction(() => pump(reason)))
      .catch((error) => {
        note('pass-failed', { reason, message: messageOf(error) })
        ctx.logger.error('model-capability-detector: pass failed')
        ctx.logger.error(error)
      })
  }

  /** Coalesce bursts of configuration writes into one pass. */
  const schedule = (reason) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      kick(reason)
    }, config.debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  })

  ctx.on('settings/document-updated', (ns) => {
    if (ns === config.settingsNs) schedule('settings-document-updated')
  })
  // A reload does not clear the inspected signature: `config` was captured when
  // `apply` ran, so a reload cannot change this plugin's own settings, and the
  // signature comparison already detects a genuinely different `providers`
  // value. Clearing it here only re-probed every endpoint on each reload.
  ctx.on('app-boot/config-reload', () => schedule('config-reload'))

  // Cover profiles imported before this plugin was installed, and a restart
  // whose configuration already names models with unfilled capabilities. The
  // holder is registered synchronously so unloading the plugin always cancels
  // the pending timer, even when it fires long after startup settled.
  const startup = { timer: undefined }
  ctx.effect(() => () => {
    if (startup.timer !== undefined) clearTimeout(startup.timer)
    startup.timer = undefined
  })
  const loader = ctx.root?.loader ?? ctx.get('loader')
  const settle =
    typeof loader?.await !== 'function'
      ? Promise.resolve()
      : Promise.resolve(loader.await()).catch(() => {})
  void settle.then(() => {
    startup.timer = setTimeout(() => {
      startup.timer = undefined
      kick('startup')
    }, config.startupDelayMs)
    if (typeof startup.timer.unref === 'function') startup.timer.unref()
  })
}
