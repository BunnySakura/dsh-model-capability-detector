/**
 * Opt-in probe of which reasoning levels one channel accepts.
 *
 * No other part of the plugin sends a completion request, so this only runs when
 * the user enables `probeEnabled` and asks for one model. It sends a handful of
 * tiny requests (a fixed prompt, a few hundred tokens at most) and reports
 * statuses only: no prompt, response text, address or key leaves this module.
 *
 * Two controls keep the answer honest:
 * - A request with an invalid level shows whether the channel validates the
 *   parameter at all. A channel that accepts anything proves nothing by
 *   accepting a real level.
 * - A request without a level shows whether the model reasons by default. If it
 *   does, reasoning in a later answer is no evidence that the level worked.
 */
import { listingHeaders } from './detect.js'
import { readJsonResponse } from './http.js'
import { cleanEfforts } from './presets.js'

export const PROBE_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const CONTROL_LEVEL = 'probe-invalid-level'
const PROMPT = 'Reply with the single word: ok'
const MAX_OUTPUT = 256
const ERROR_BYTES = 16 * 1024

class ProbeAbort extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}

/** The chat-completions URL of an OpenAI-compatible base address. */
export function completionsUrl(baseURL) {
  const base = new URL(baseURL)
  base.hash = ''
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/chat/completions`
  return base.toString()
}

/** Whether one completion shows reasoning: reasoning tokens or reasoning text. */
export function showsReasoning(body) {
  const message = body?.choices?.[0]?.message
  const tokens = body?.usage?.completion_tokens_details?.reasoning_tokens ?? body?.usage?.reasoning_tokens
  if (Number.isFinite(tokens) && tokens > 0) return true
  if ([message?.reasoning_content, message?.reasoning, message?.thinking].some((text) => typeof text === 'string' && text.trim().length > 0)) return true
  return Array.isArray(message?.reasoning_details) && message.reasoning_details.length > 0
}

async function readSmall(response) {
  try {
    const reader = response.body?.getReader()
    if (reader === undefined) return ''
    let text = ''
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      text += Buffer.from(value).toString('utf8')
      if (bytes > ERROR_BYTES) { await reader.cancel(); break }
    }
    return text
  } catch { return '' }
}

/**
 * @param options.baseURL channel base address; must be an OpenAI-compatible chat API.
 * @param options.apiKey resolved credential, if any.
 * @param options.headers the route's extra request headers.
 * @param options.model model id as the channel lists it.
 * @returns `{ ok: false, reason }`, or `{ ok: true, verdict, baseline, validates, levels, proposal?, requests }`.
 */
export async function probeModel({ baseURL, apiKey, headers, model, timeoutMs = 20000, maxResponseBytes = 256 * 1024, signal }) {
  let url
  try { url = completionsUrl(baseURL) } catch { return { ok: false, reason: 'invalid-request' } }
  const baseHeaders = listingHeaders('openai', apiKey, headers)
  baseHeaders.set('content-type', 'application/json')
  const state = { tokenField: 'max_tokens', requests: 0 }

  /** One request: `'rejected'`, or `{ reasoned }` when the channel answered. */
  async function ask(effort) {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted()
      state.requests += 1
      const body = {
        model, messages: [{ role: 'user', content: PROMPT }], stream: false, [state.tokenField]: MAX_OUTPUT,
        ...effort === undefined ? {} : { reasoning_effort: effort },
      }
      let response
      try {
        response = await fetch(url, {
          method: 'POST', headers: baseHeaders, body: JSON.stringify(body), redirect: 'error',
          signal: AbortSignal.any([...signal === undefined ? [] : [signal], AbortSignal.timeout(timeoutMs)]),
        })
      } catch { throw new ProbeAbort(signal?.aborted ? 'aborted' : 'unreachable') }
      if (response.ok) {
        try { return { reasoned: showsReasoning(await readJsonResponse(response, maxResponseBytes)) } } catch { throw new ProbeAbort('bad-response') }
      }
      const detail = await readSmall(response)
      if (response.status === 400 || response.status === 422) {
        // Some channels want the other spelling of the output limit; try it once.
        if (attempt === 0 && /max_completion_tokens|max_tokens/i.test(detail)) {
          state.tokenField = state.tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
          continue
        }
        return 'rejected'
      }
      throw new ProbeAbort(response.status === 401 || response.status === 403 ? 'unauthorized'
        : response.status === 404 ? 'not-found' : response.status === 429 ? 'rate-limited'
          : response.status >= 500 ? 'server-error' : 'refused')
    }
    return 'rejected'
  }

  try {
    const baseline = await ask(undefined)
    if (baseline === 'rejected') return { ok: false, reason: 'baseline-rejected' }
    const control = await ask(CONTROL_LEVEL)
    const validates = control === 'rejected'
    const levels = {}
    for (const level of PROBE_LEVELS) {
      const answer = await ask(level)
      levels[level] = answer === 'rejected' ? 'rejected' : answer.reasoned ? 'reasoned' : 'accepted'
    }
    // Without a default reasoning phase, a level that makes the model reason has an effect.
    // With one, only a channel that rejects invalid levels makes acceptance meaningful.
    const usable = PROBE_LEVELS.filter((level) => levels[level] !== 'rejected'
      && (baseline.reasoned ? validates : levels[level] === 'reasoned'))
    const proposal = usable.length === 0 ? undefined
      : cleanEfforts({ ...baseline.reasoned ? {} : { off: null }, ...Object.fromEntries(usable.map((level) => [level, level])) })
    const verdict = proposal !== undefined ? 'proposal' : baseline.reasoned && !validates ? 'unverifiable' : 'no-evidence'
    return { ok: true, verdict, baseline: { reasoned: baseline.reasoned }, validates, levels, ...proposal === undefined ? {} : { proposal }, requests: state.requests }
  } catch (error) {
    if (error instanceof ProbeAbort) return { ok: false, reason: error.reason }
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    throw error
  }
}
