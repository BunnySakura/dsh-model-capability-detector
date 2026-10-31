/** Local origin receipts. Never persist provider URLs, headers or credentials. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
          receipts[provenanceKey(route, model, field)] = { value, source, at }
        }
        // Bound the journal; insertion order makes old entries first.
        const bounded = Object.fromEntries(Object.entries(receipts).slice(-5000))
        await mkdir(directory, { recursive: true })
        await writeFile(file, JSON.stringify({ version: 1, receipts: bounded }), { encoding: 'utf8', mode: 0o600 })
      }).catch(() => {})
      return queue
    },
    flush: () => queue,
  }
}
