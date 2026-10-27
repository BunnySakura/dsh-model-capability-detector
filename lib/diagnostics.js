/**
 * A durable, opt-in diagnostics log.
 *
 * DSH's logger keeps messages in a 1000-entry in-memory ring and this
 * deployment registers no sink that writes them to disk, so a failed detection
 * pass leaves no trace a user can read. That matters here because the plugin's
 * failure mode is silence: it decides not to write, and "decided not to write"
 * is indistinguishable from "never ran" without a record.
 *
 * This log is off by default and writes only when `logFile` names a path. It
 * records decisions, never credentials: no API key, no header value, and no
 * response body ever reaches it.
 *
 * @module dsh-model-capability-detector/diagnostics
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Keep a runaway log from filling the disk. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** Retain one rotation so a recent failure survives a restart. */
const ROTATED_SUFFIX = '.1'

/** Reduce a provider route or URL to something safe to log. */
export function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  try {
    const parsed = new URL(value)
    // Query strings may carry a key; report only origin and path.
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return value
  }
}

/**
 * Create a logger that appends newline-delimited JSON to one file.
 *
 * Writes are serialized through a promise chain so concurrent passes cannot
 * interleave partial lines, and every failure is swallowed: diagnostics must
 * never break the capability pass they are observing.
 * @param path - absolute log file path, or `undefined` to disable logging.
 * @returns the logger's `write` and `error` entry points.
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
        const previous = await readFile(path, 'utf8').catch(() => '')
        await writeFile(`${path}${ROTATED_SUFFIX}`, previous, 'utf8')
        await writeFile(path, '', 'utf8')
      }
    } catch {
      // Rotation is best effort; appending to a large file still works.
    }
    await appendFile(path, `${line}\n`, 'utf8')
  }

  const write = (event, detail) => {
    const record = { at: new Date().toISOString(), event, ...detail }
    queue = queue
      .then(() => append(JSON.stringify(record)))
      .catch(() => {})
    return queue
  }

  return {
    enabled: true,
    write,
    /** Resolve once every queued line has been written. */
    flush: () => queue,
  }
}
