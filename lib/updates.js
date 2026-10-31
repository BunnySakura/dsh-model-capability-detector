/** Public release metadata only. No provider state enters these requests. */
import { readJsonResponse } from './http.js'

export const UPDATE_REPOSITORY = 'BunnySakura/dsh-model-capability-detector'
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000

export function parseVersion(raw) {
  if (typeof raw !== 'string' || raw.length > 128) return undefined
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(raw)
  if (!match) return undefined
  const parts = match.slice(1, 4).map(Number)
  if (!parts.every(Number.isSafeInteger)) return undefined
  const pre = match[4]?.split('.') ?? []
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return { version: raw.replace(/^v/, ''), parts, pre }
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right)
  if (!a || !b) throw new Error('invalid release version')
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) return x.length === y.length ? x > y ? 1 : -1 : x.length > y.length ? 1 : -1
    if (nx !== ny) return nx ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function readRelease(body, currentVersion) {
  const parsed = parseVersion(body?.tag_name)
  if (!parsed || parsed.pre.length || body.draft !== false || body.prerelease !== false) throw new Error('invalid stable release')
  // Construct destinations ourselves. Never trust release-provided install URLs.
  const tag = body.tag_name
  const releaseUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`
  return { currentVersion, version: parsed.version, tag,
    available: compareVersions(parsed.version, currentVersion) > 0,
    releaseUrl, installTarget: `git+https://github.com/${UPDATE_REPOSITORY}.git#${tag}`,
    notes: typeof body.body === 'string' ? body.body.slice(0, 12000) : '',
    publishedAt: typeof body.published_at === 'string' && Number.isFinite(Date.parse(body.published_at)) ? body.published_at : null }
}

export function createUpdateChecker({ currentVersion, signal, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }) {
  let cached, pending
  return {
    snapshot: () => cached ? structuredClone(cached) : { status: 'unchecked', currentVersion },
    async check({ refresh = false } = {}) {
      if (signal?.aborted) return { status: 'cancelled', currentVersion }
      if (pending) return pending
      const age = cached ? now() - cached.checkedAt : Infinity
      if (!refresh && age >= 0 && age < CHECK_TTL_MS) return structuredClone(cached)
      pending = (async () => {
        const controller = new AbortController()
        const relay = () => controller.abort()
        signal?.addEventListener('abort', relay, { once: true })
        const timer = setTimeout(relay, timeoutMs)
        timer.unref?.()
        let result
        try {
          const response = await fetchImpl(RELEASES_URL, { method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } })
          if (!response.ok) {
            await response.body?.cancel()
            result = { status: response.status === 404 ? 'no-release' : response.status === 403 || response.status === 429 ? 'rate-limited' : 'unavailable', currentVersion }
          } else {
            const release = readRelease(await readJsonResponse(response, 256 * 1024), currentVersion)
            controller.signal.throwIfAborted()
            result = { status: 'checked', ...release }
          }
        } catch {
          result = { status: signal?.aborted ? 'cancelled' : 'unavailable', currentVersion }
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', relay)
        }
        cached = { ...result, checkedAt: now() }
        return structuredClone(cached)
      })()
      try { return await pending } finally { pending = undefined }
    },
  }
}