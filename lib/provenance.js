/** Local origin receipts. Never persist provider URLs, headers or credentials. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from './fsutil.js'

export const provenanceKey = (route, model, field) => createHash('sha256').update(JSON.stringify([route, model, field])).digest('hex')

export function createProvenance(homePath) {
  let queue = Promise.resolve()
  const directory = typeof homePath === 'string' ? join(homePath, 'cache', 'model-capability-detector') : undefined
  return {
    record(entries) {
      if (!directory || !entries?.length) return Promise.resolve()
      queue = queue.then(async () => {
        const file = join(directory, 'provenance.json')
        let receipts = {}
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8'))
          if (parsed?.version === 1 && parsed.receipts && typeof parsed.receipts === 'object' && !Array.isArray(parsed.receipts)) receipts = parsed.receipts
        } catch { /* A missing receipt never blocks capability detection. */ }
        const at = new Date().toISOString()
        for (const { route, model, field, value, source } of entries) {
          const key = provenanceKey(route, model, field)
          // Re-insert so a refreshed receipt becomes the newest, not the first to be trimmed.
          Reflect.deleteProperty(receipts, key)
          receipts[key] = { value, source, at }
        }
        // Bound the journal; insertion order makes old entries first.
        const bounded = Object.fromEntries(Object.entries(receipts).slice(-5000))
        await writeFileAtomic(file, JSON.stringify({ version: 1, receipts: bounded }), 0o600)
      }).catch(() => {})
      return queue
    },
    /** Receipts as a lookup function; empty when nothing was recorded yet. */
    async load() {
      let receipts = {}
      if (directory) {
        try {
          const parsed = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'))
          if (parsed?.version === 1 && parsed.receipts && typeof parsed.receipts === 'object' && !Array.isArray(parsed.receipts)) receipts = parsed.receipts
        } catch { /* No receipts means every value is treated as the user's. */ }
      }
      return (route, model, field) => {
        const receipt = receipts[provenanceKey(route, model, field)]
        return receipt !== null && typeof receipt === 'object' ? receipt : undefined
      }
    },
    flush: () => queue,
  }
}
