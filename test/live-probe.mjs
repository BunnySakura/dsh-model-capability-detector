/**
 * End-to-end probe against a live, public listing: fetch OpenRouter's model
 * catalog and run every advertised entry through the detection helpers.
 *
 * Run: node test/live-probe.mjs [baseURL]
 * Defaults to OpenRouter, whose listing carries the richest metadata of the
 * shapes this plugin reads. The network call is the only side effect.
 */

import { listingUrl, readListing } from '../lib/detect.js'

const baseURL = process.argv[2] ?? 'https://openrouter.ai/api/v1'
const target = listingUrl(baseURL, 'openai-completions')

const response = await fetch(target.url, { headers: { accept: 'application/json' } })
if (!response.ok) {
  console.error(`${target.url} answered ${response.status}`)
  process.exit(1)
}
const body = await response.json()
const models = readListing(body)

const withContext = models.filter((model) => model.contextWindow !== undefined)
const withImage = models.filter((model) => model.input?.includes('image'))
const withEfforts = models.filter((model) => model.reasoningEfforts !== undefined)
const nonReasoning = models.filter((model) => model.reasoningEfforts === false)

console.log(`endpoint      ${target.url}`)
console.log(`entries       ${models.length}`)
console.log(`contextWindow ${withContext.length}`)
console.log(`image input   ${withImage.length}`)
console.log(`efforts dict  ${withEfforts.length}`)
console.log(`no reasoning  ${nonReasoning.length}`)
console.log('')
for (const model of models.slice(0, 3)) console.log(JSON.stringify(model))
for (const model of withEfforts.slice(0, 3)) console.log(JSON.stringify(model))
