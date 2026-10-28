/** Read-only probe of a public OpenAI-compatible listing; no credentials read.
 * Run: node test/live-probe.mjs [baseURL]
 */
import { listingUrl, readListing } from '../lib/detect.js'
import { redactUrl, sanitizeMessage } from '../lib/diagnostics.js'
import { readJsonResponse } from '../lib/http.js'

try {
  const baseURL = process.argv[2] ?? 'https://openrouter.ai/api/v1'
  const target = listingUrl(baseURL, 'openai-completions')
  const response = await fetch(target.url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`listing answered ${response.status}`)
  }
  const models = readListing(await readJsonResponse(response, 4 * 1024 * 1024))
  const withContext = models.filter((model) => model.contextWindow !== undefined)
  const withImage = models.filter((model) => model.input?.includes('image'))
  const withEfforts = models.filter((model) => model.reasoningEfforts !== undefined)
  const nonReasoning = models.filter((model) => model.reasoningEfforts === false)
  console.log(`endpoint      ${redactUrl(target.url)}`)
  console.log(`entries       ${models.length}`)
  console.log(`contextWindow ${withContext.length}`)
  console.log(`image input   ${withImage.length}`)
  console.log(`efforts dict  ${withEfforts.length}`)
  console.log(`no reasoning  ${nonReasoning.length}`)
  for (const model of [...models.slice(0, 3), ...withEfforts.slice(0, 3)]) {
    console.log(sanitizeMessage(JSON.stringify(model)))
  }
} catch (error) {
  console.error(sanitizeMessage(error))
  process.exitCode = 1
}
