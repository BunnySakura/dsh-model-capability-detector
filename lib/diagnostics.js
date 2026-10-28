/**
 * A durable, opt-in diagnostics log.
 *
 * Writes are disabled unless `logFile` names a path. Every entry is sanitized
 * at the write boundary, including messages, URLs and nested details.
 *
 * @module dsh-model-capability-detector/diagnostics
 */

import { appendFile, copyFile, mkdir, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Keep a runaway log from filling the disk. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** Retain one rotation so a recent failure survives a restart. */
const ROTATED_SUFFIX = '.1'
const REDACTED = '[REDACTED]'
const OMITTED = '[Unsupported diagnostic value]'
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi
const AUTHORIZATION = /(\b(?:proxy[-_])?authorization\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:[a-z][a-z0-9_-]*\s+)?[^\s,;]+)/gi
const SECRET_ASSIGNMENT = /(["']?\b(?:x[-_]?api[-_]?key|api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|password|passwd|pwd|secret|credentials?|authorization|cookie|set[-_]?cookie)\b["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi

/** Reduce a provider URL to its endpoint, including for malformed URL text. */
export function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.origin === 'null' ? parsed.toString() : `${parsed.origin}${parsed.pathname}`
  } catch {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1').split(/[?#]/, 1)[0]
  }
}

/**
 * Return safe text for a logger. Error inputs expose only their data-property
 * message; causes, stacks, getters and arbitrary object serializers are ignored.
 */
export function sanitizeMessage(value) {
  let message
  try {
    if (typeof value === 'string') message = value
    else if (value instanceof Error) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'message')
      message = typeof descriptor?.value === 'string' ? descriptor.value : 'Error'
    } else if (value === null || ['undefined', 'number', 'boolean', 'bigint'].includes(typeof value)) {
      message = String(value)
    } else return OMITTED
  } catch {
    return OMITTED
  }
  return message
    .replace(URL_PATTERN, (match) => {
      const trailing = /[),.!?]+$/.exec(match)?.[0] ?? ''
      return redactUrl(match.slice(0, match.length - trailing.length)) + trailing
    })
    .replace(AUTHORIZATION, (_, prefix) => `${prefix}${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (_, scheme) => `${scheme} ${REDACTED}`)
    .replace(/(\b(?:headers|credentials)\b["']?\s*[:=]\s*)[^\r\n]+/gi, (_, prefix) => `${prefix}${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_, prefix) => `${prefix}${REDACTED}`)
    .replace(/\bsk-[a-z0-9_-]{6,}/gi, REDACTED)
}

const SENSITIVE_FIELDS = new Set([
  'authorization', 'proxyauthorization', 'xapikey', 'apikey', 'key', 'token',
  'accesstoken', 'refreshtoken', 'authtoken', 'clientsecret', 'secretkey',
  'password', 'passwd', 'pwd', 'secret', 'credential', 'cookie', 'setcookie',
])

function sensitiveField(key) {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase()
  return normalized.endsWith('headers') || normalized.endsWith('credentials') || SENSITIVE_FIELDS.has(normalized)
}

/** Build a detached JSON-safe value without invoking getters or toJSON. */
function sanitizeDetail(value, ancestors = new WeakSet(), depth = 0) {
  if (typeof value === 'string' || value instanceof Error) return sanitizeMessage(value)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'undefined') return undefined
  if (typeof value !== 'object') return OMITTED
  if (depth >= 20) return '[Depth limit]'
  if (ancestors.has(value)) return '[Circular]'
  try {
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (!array && prototype !== Object.prototype && prototype !== null) return OMITTED
    ancestors.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = array ? [] : Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue
      const safeKey = sanitizeMessage(key)
      const item = sensitiveField(key) ? REDACTED
        : 'value' in descriptor ? sanitizeDetail(descriptor.value, ancestors, depth + 1) : OMITTED
      Object.defineProperty(result, safeKey, { value: item, enumerable: true, configurable: true })
    }
    return result
  } catch {
    return OMITTED
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Create a logger that appends newline-delimited JSON to one file.
 *
 * Writes are serialized and every failure is swallowed: diagnostics must never
 * break the capability pass they are observing.
 * @param path - absolute log file path, or `undefined` to disable logging.
 * @returns the logger's `enabled`, `write` and `flush` entry points.
 */
export function createDiagnostics(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return { enabled: false, write() {}, flush: async () => {} }
  }

  let queue = Promise.resolve()
  let prepared

  const prepare = () => {
    prepared ??= mkdir(dirname(path), { recursive: true }).catch(() => {})
    return prepared
  }

  const append = async (line) => {
    await prepare()
    try {
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && info.size > MAX_LOG_BYTES) {
        await copyFile(path, `${path}${ROTATED_SUFFIX}`)
        await truncate(path, 0)
      }
    } catch {
      // Rotation is best effort; appending to a large file still works.
    }
    await appendFile(path, `${line}\n`, 'utf8')
  }

  const write = (event, detail) => {
    let record
    try {
      const safeDetail = sanitizeDetail(detail)
      record = {
        ...(safeDetail !== null && typeof safeDetail === 'object' && !Array.isArray(safeDetail) ? safeDetail : {}),
        at: new Date().toISOString(),
        event: sanitizeMessage(event),
      }
    } catch {
      record = { at: new Date().toISOString(), event: sanitizeMessage(event), detail: OMITTED }
    }
    queue = queue.then(() => append(JSON.stringify(record))).catch(() => {})
    return queue
  }

  return {
    enabled: true,
    write,
    /** Resolve once every queued line has been written. */
    flush: () => queue,
  }
}
