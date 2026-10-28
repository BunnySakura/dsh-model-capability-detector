/** Bounded response reads shared by endpoint and catalog downloads. */
export async function readJsonResponse(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`response declares more than ${maxBytes} bytes`)
  }
  const chunks = []
  let bytes = 0
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response has no body')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new Error(`response exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } catch {
    throw new Error('response did not answer with JSON')
  }
}
