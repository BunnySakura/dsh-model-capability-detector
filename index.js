/**
 * Model capability detection for imported provider profiles.
 *
 * Saving a provider on the Models page writes it into the profile patch and the
 * settings service emits `settings/document-updated`. This plugin listens for
 * that, interrogates the provider's model listing (`GET {baseURL}/models`), and
 * writes the detected capabilities back into the same profile entry: context
 * window, output cap, image input, and reasoning levels.
 *
 * A capability that no listing entry discloses stays untouched rather than
 * guessed: a wrong `contextWindow` silently truncates conversations, and a
 * wrong `input` list hides images the model does support.
 *
 * @module dsh-model-capability-detector
 */

import { configured, listingHeaders, listingUrl, readListing } from './lib/detect.js'
import { FIELDS, describeChanges, mergeDetected, sameProviders } from './lib/plan.js'

export const name = 'model-capability-detector'
export const inject = ['settings', 'credentials']

/** Deployment-tunable row values; the profile patch layer carries them. */
export const DEFAULT_CONFIG = {
  /** Profile entry id of the LLM adapter whose `providers` this plugin fills. */
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
}

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
  /** Serialized `providers` this plugin last wrote, to skip the echo event. */
  let lastWritten
  /** Serialized `providers` already interrogated, to avoid repeating a probe. */
  let lastInspected

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
      ctx.logger.warn('model-capability-detector: settings are unavailable: %s', messageOf(error))
      return undefined
    }
    const row = rows.find((entry) => entry.ns === config.settingsNs)
    if (row === undefined) {
      ctx.logger.debug(
        'model-capability-detector: no "%s" entry in this profile',
        config.settingsNs,
      )
      return undefined
    }
    const providers = row.user?.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
      ctx.logger.debug(
        'model-capability-detector: entry "%s" declares no providers in this profile layer; inherited routes are left to the bundle that declares them',
        config.settingsNs,
      )
      return undefined
    }
    return { providers, revision: row.revision }
  }

  /**
   * Discover capabilities for every route that names an endpoint.
   * @param providers - the profile's own `providers` value.
   * @returns the capabilities per route, and whether any route failed to answer.
   */
  const detect = async (providers) => {
    const byRoute = new Map()
    let failed = false
    for (const [route, profile] of Object.entries(providers)) {
      if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) continue
      if (!Array.isArray(profile.models) || profile.models.length === 0) continue
      const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
      if (baseURL.length === 0) {
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
        ctx.logger.debug(
          'model-capability-detector: route "%s" advertised %d models',
          route,
          listing.length,
        )
      } catch (error) {
        failed = true
        ctx.logger.warn(
          'model-capability-detector: route "%s" could not be interrogated: %s',
          route,
          messageOf(error),
        )
      }
    }
    return { byRoute, failed }
  }

  /**
   * Whether any configured route still has a capability field to fill.
   *
   * This runs before any network call, so a settings change on a profile whose
   * models are fully described costs nothing. With `overwrite` the pass always
   * runs, because a listing may disagree with a value the user typed.
   * @param providers - the profile's own `providers` value.
   * @returns whether detection could change anything.
   */
  const hasBlanks = (providers) => {
    if (config.overwrite === true) return true
    for (const profile of Object.values(providers)) {
      if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) continue
      if (!Array.isArray(profile.models)) continue
      for (const model of profile.models) {
        if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
        if (typeof model.id !== 'string' || model.id.length === 0) continue
        if (FIELDS.some((field) => !configured(model[field]))) return true
      }
    }
    return false
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
    outsideTransaction(() => ctx.settings.update(config.settingsNs, { providers }, revision))  /** One detection pass over the configured namespace. */
  const runOnce = async (reason) => {
    const current = readProfile()
    if (current === undefined) return
    const signature = JSON.stringify(current.providers)
    if (lastWritten !== undefined && signature === lastWritten) {
      ctx.logger.debug('model-capability-detector: skipping the echo of our own write')
      return
    }
    if (lastInspected === signature) {
      ctx.logger.debug('model-capability-detector: this value was already inspected')
      return
    }
    if (!hasBlanks(current.providers)) {
      lastInspected = signature
      ctx.logger.debug('model-capability-detector: every model is described after "%s"', reason)
      return
    }
    const { byRoute: detected, failed } = await detect(current.providers)
    // A failed interrogation leaves the signature uninspected so the next
    // settings change or reload retries it.
    if (detected.size === 0) return
    if (!failed) lastInspected = signature
    const { providers, changes } = mergeDetected(
      current.providers,
      detected,
      config.overwrite === true,
    )
    if (changes.length === 0 || sameProviders(providers, current.providers)) {
      ctx.logger.debug('model-capability-detector: nothing to fill after "%s"', reason)
      return
    }
    const report = describeChanges(changes).join('\n')
    if (config.dryRun === true) {
      ctx.logger.info(
        'model-capability-detector: dry run after "%s", would set:\n%s',
        reason,
        report,
      )
      return
    }
    lastWritten = JSON.stringify(providers)
    try {
      await writeProfile(providers, current.revision)
      ctx.logger.info('model-capability-detector: detected capabilities:\n%s', report)
    } catch (error) {
      lastWritten = undefined
      // A concurrent edit makes the revision stale; the resulting document event
      // schedules another pass against the fresh value.
      ctx.logger.warn('model-capability-detector: write refused: %s', messageOf(error))
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
  ctx.on('app-boot/config-reload', () => {
    lastWritten = undefined
    lastInspected = undefined
    schedule('config-reload')
  })

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
