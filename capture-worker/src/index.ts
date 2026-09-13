import { randomUUID } from 'node:crypto'
import { CaptureAnalytics } from './analytics.js'
import { capturePage } from './capture.js'
import { loadConfig } from './config.js'
import { CaptureDatabase } from './database.js'
import { log } from './log.js'
import { startServer } from './server.js'
import { ObjectStorage } from './storage.js'

const config = loadConfig()
const database = new CaptureDatabase(config.databaseUrl)
const analytics = new CaptureAnalytics(config)
const storage = new ObjectStorage(config)

await database.migrate()
await analytics.migrate()
await storage.ensureBucket()
const server = startServer(config, database, analytics, storage)
log('info', 'capture worker started', { port: config.port, concurrency: config.concurrency })

let running = true
const loops: Promise<void>[] = []
for (let index = 0; index < config.concurrency; index++) loops.push(jobLoop(randomUUID()))
loops.push(analyticsLoop(randomUUID()), eventLoop(randomUUID()))

async function jobLoop(workerId: string): Promise<void> {
  while (running) {
    const job = await database.claimJob(workerId).catch((error: unknown) => {
      log('error', 'claim capture failed', { workerId, errorType: errorName(error) })
      return null
    })
    if (!job) {
      await delay(config.workerPollMillis)
      continue
    }
    const leaseTimer = setInterval(() => {
      void database.extendLease(job).then((ok) => {
        if (!ok) log('warn', 'capture lease was lost', { captureRequestId: job.id })
      }).catch((error: unknown) => log('warn', 'capture lease heartbeat failed', {
        captureRequestId: job.id, errorType: errorName(error),
      }))
    }, 10_000)
    try {
      log('info', 'capture started', { captureRequestId: job.id, correlationId: job.correlationId, attempt: job.attemptCount })
      const result = await capturePage(job.payload)
      const prefix = `${job.ownerId}/${job.id}`
      const htmlObject = await storage.put(`${prefix}/rendered.html`, result.html, 'text/html; charset=utf-8')
      const screenshotObject = await storage.put(`${prefix}/screenshot.jpg`, result.screenshot, 'image/jpeg')
      const resourceObjects = []
      for (const resource of result.resourceBodies) {
        const object = await storage.put(
          `${prefix}/resources/${resource.sequence}-${resource.resourceId}`,
          resource.body,
          resource.mimeType || 'application/octet-stream',
        )
        resourceObjects.push({ resource, object })
      }
      await database.stageResult(job, result, htmlObject, screenshotObject, resourceObjects)
      log('info', 'capture staged', {
        captureRequestId: job.id, networkCount: result.network.length,
        resourceCount: resourceObjects.length,
      })
    } catch (error) {
      const code = boundedErrorCode(error)
      log('warn', 'capture attempt failed', { captureRequestId: job.id, errorCode: code, attempt: job.attemptCount })
      await database.failJob(job, code)
    } finally {
      clearInterval(leaseTimer)
    }
  }
}

async function analyticsLoop(workerId: string): Promise<void> {
  while (running) {
    const outbox = await database.claimAnalytics(workerId).catch(() => null)
    if (!outbox) {
      await delay(config.analyticsPollMillis)
      continue
    }
    try {
      await analytics.write(outbox)
      await database.completeAnalytics(outbox)
    } catch (error) {
      log('warn', 'capture analytics delivery failed', { outboxId: outbox.id, errorType: errorName(error) })
      await database.retryAnalytics(outbox, 'CLICKHOUSE_DELIVERY_FAILED')
    }
  }
}

async function eventLoop(workerId: string): Promise<void> {
  while (running) {
    const event = await database.claimEvent(workerId).catch(() => null)
    if (!event) {
      await delay(config.eventPollMillis)
      continue
    }
    try {
      const response = await fetch(config.controlEventUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WebLens-Service-Token': config.serviceToken,
          'Idempotency-Key': event.messageId,
        },
        body: JSON.stringify(event.payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`CONTROL_HTTP_${response.status}`)
      await database.completeEvent(event)
    } catch (error) {
      log('warn', 'capture event delivery failed', { messageId: event.messageId, errorType: errorName(error) })
      await database.retryEvent(event, 'CONTROL_DELIVERY_FAILED')
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return
  running = false
  log('info', 'capture worker stopping', { signal })
  server.close()
  await Promise.allSettled(loops)
  await Promise.allSettled([database.close(), analytics.close()])
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

function boundedErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'CAPTURE_FAILED'
  return raw.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').slice(0, 64) || 'CAPTURE_FAILED'
}
