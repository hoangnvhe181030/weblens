import { performance } from 'node:perf_hooks'
import { classifyRequestError } from './metrics.mjs'

export async function measuredRequest(url, init, timeoutMs, metrics, maxResponseBytes = 1024 * 1024) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const startedAt = performance.now()
  metrics?.start()

  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    })
    const bytes = await drainBody(response, maxResponseBytes)
    metrics?.finish({ status: response.status, latencyMs: performance.now() - startedAt, bytes })
    return { response, bytes }
  } catch (error) {
    const category = classifyRequestError(error)
    metrics?.finish({ error: category, latencyMs: performance.now() - startedAt })
    return { error: category }
  } finally {
    clearTimeout(timeout)
  }
}

export async function jsonRequest(url, init, timeoutMs, { maxResponseBytes = 1024 * 1024 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const startedAt = performance.now()
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
    const body = await readBody(response, maxResponseBytes)
    let json = null
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString('utf8'))
      } catch {
        throw new RequestFailure('INVALID_JSON', response.status)
      }
    }
    return { response, json, latencyMs: Math.ceil(performance.now() - startedAt), bytes: body.length }
  } catch (error) {
    if (error instanceof RequestFailure) throw error
    throw new RequestFailure(classifyRequestError(error))
  } finally {
    clearTimeout(timeout)
  }
}

export async function requireHealthy(url, timeoutMs, label) {
  const result = await jsonRequest(url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs)
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`${label} chưa sẵn sàng (HTTP ${result.response.status}).`)
  }
  if (result.json?.status && result.json.status !== 'UP') {
    throw new Error(`${label} chưa sẵn sàng (status=${String(result.json.status)}).`)
  }
  return { status: result.response.status, latencyMs: result.latencyMs }
}

export class RequestFailure extends Error {
  constructor(category, status) {
    super(category)
    this.name = 'RequestFailure'
    this.category = category
    this.status = status
  }
}

async function drainBody(response, maximumBytes) {
  if (!response.body) return 0
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return bytes
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new RequestFailure('RESPONSE_TOO_LARGE', response.status)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
async function readBody(response, maximumBytes) {
  if (!response.body) return Buffer.alloc(0)
  const chunks = []
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, bytes)
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new RequestFailure('RESPONSE_TOO_LARGE', response.status)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
}
