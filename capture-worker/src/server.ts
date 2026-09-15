import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { CaptureAnalytics, CaptureResourceRecord } from './analytics.js'
import type { Config } from './config.js'
import type { CaptureDatabase, ScreenshotReference } from './database.js'
import type { ObjectStorage } from './storage.js'
import type { CaptureCommandEnvelope } from './types.js'

const maxCommandBytes = 64 * 1024

type CaptureServerDatabase = Pick<
  CaptureDatabase,
  'ping' | 'acceptCommand' | 'getSnapshot' | 'getScreenshotReference' | 'getResourceReference'
  | 'getReconstruction' | 'getReconstructionArchiveReference'
>
type CaptureServerAnalytics = Pick<CaptureAnalytics, 'ping' | 'listResources'>

export function startServer(
  config: Config,
  database: CaptureServerDatabase,
  analytics: CaptureServerAnalytics,
  storage: Pick<ObjectStorage, 'get'>,
) {
  return createServer(async (request, response) => {
    setHeaders(response)
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (request.method === 'GET' && url.pathname === '/health/live') return json(response, 200, { status: 'UP' })
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        await Promise.all([database.ping(), analytics.ping()])
        return json(response, 200, { status: 'UP' })
      }
      if (!authenticated(request, config.serviceToken)) return problem(response, 401, 'SERVICE_AUTHENTICATION_REQUIRED')
      if (request.method === 'POST' && url.pathname === '/internal/v1/commands/captures') {
        const envelope = parseEnvelope(await readBody(request))
        const duplicate = await database.acceptCommand(envelope)
        return json(response, duplicate ? 200 : 202, { accepted: true, duplicate, captureRequestId: envelope.aggregateId })
      }
      const screenshotMatch = /^\/internal\/v1\/reports\/captures\/([0-9a-f-]+)\/artifacts\/screenshot$/u.exec(url.pathname)
      if (request.method === 'GET' && screenshotMatch?.[1]) {
        const ownerId = url.searchParams.get('ownerId') ?? ''
        const reference = await database.getScreenshotReference(ownerId, screenshotMatch[1])
        if (!reference) return problem(response, 404, 'CAPTURE_ARTIFACT_NOT_FOUND')
        ensureNotExpired(reference)
        const artifact = verifyArtifact(await storage.get(reference.bucket, reference.key), reference)
        return binary(response, 200, artifact, reference.sha256Hex, 'image/jpeg', 'inline; filename="capture.jpg"')
      }
      const resourceMatch = /^\/internal\/v1\/reports\/captures\/([0-9a-f-]+)\/resources\/([0-9a-f-]+)\/content$/u.exec(url.pathname)
      if (request.method === 'GET' && resourceMatch?.[1] && resourceMatch[2]) {
        const ownerId = url.searchParams.get('ownerId') ?? ''
        const reference = await database.getResourceReference(ownerId, resourceMatch[1], resourceMatch[2])
        if (!reference) return problem(response, 404, 'CAPTURE_RESOURCE_NOT_FOUND')
        ensureNotExpired(reference)
        const artifact = verifyArtifact(await storage.get(reference.bucket, reference.key), reference)
        return binary(
          response,
          200,
          artifact,
          reference.sha256Hex,
          'application/octet-stream',
          'attachment; filename="captured-resource.bin"',
        )
      }
      const reconstructionMatch = /^\/internal\/v1\/reports\/captures\/([0-9a-f-]+)\/reconstruction$/u.exec(url.pathname)
      if (request.method === 'GET' && reconstructionMatch?.[1]) {
        const ownerId = url.searchParams.get('ownerId') ?? ''
        const reconstruction = await database.getReconstruction(ownerId, reconstructionMatch[1])
        if (!reconstruction) return problem(response, 404, 'RECONSTRUCTION_NOT_FOUND')
        return json(response, 200, reconstructionResponse(reconstruction))
      }
      const archiveMatch = /^\/internal\/v1\/reports\/reconstructions\/([0-9a-f-]+)\/artifacts\/archive$/u.exec(url.pathname)
      if (request.method === 'GET' && archiveMatch?.[1]) {
        const ownerId = url.searchParams.get('ownerId') ?? ''
        const reference = await database.getReconstructionArchiveReference(ownerId, archiveMatch[1])
        if (!reference) return problem(response, 404, 'RECONSTRUCTION_ARTIFACT_NOT_FOUND')
        if (reference.state !== 'PUBLISHED') throw new Error('ARTIFACT_EXPIRED')
        ensureNotExpired(reference)
        const artifact = verifyArtifact(await storage.get(reference.bucket, reference.key), reference)
        return binary(
          response,
          200,
          artifact,
          reference.sha256Hex,
          'application/zip',
          'attachment; filename="weblens-static-clone.zip"',
        )
      }
      const match = /^\/internal\/v1\/reports\/captures\/([0-9a-f-]+)$/u.exec(url.pathname)
      if (request.method === 'GET' && match?.[1]) {
        const ownerId = url.searchParams.get('ownerId') ?? ''
        const snapshot = await database.getSnapshot(ownerId, match[1])
        if (!snapshot) return problem(response, 404, 'CAPTURE_NOT_FOUND')
        const resources = await analytics.listResources(ownerId, match[1])
        return json(response, 200, snapshotResponse(snapshot, resources))
      }
      return problem(response, 404, 'NOT_FOUND')
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INTERNAL_ERROR'
      if (code === 'MESSAGE_ID_COLLISION') return problem(response, 409, code)
      if (code.startsWith('INVALID_')) return problem(response, 400, code)
      if (code === 'ARTIFACT_EXPIRED' || code === 'ARTIFACT_OBJECT_MISSING') {
        return problem(response, 410, 'CAPTURE_ARTIFACT_GONE')
      }
      if (code === 'ARTIFACT_SIZE_MISMATCH' || code === 'ARTIFACT_HASH_MISMATCH') {
        return problem(response, 503, 'CAPTURE_ARTIFACT_INTEGRITY_FAILED')
      }
      return problem(response, 503, 'SERVICE_UNAVAILABLE')
    }
  }).listen(config.port)
}

function snapshotResponse(
  snapshot: Record<string, unknown>,
  resources: CaptureResourceRecord[],
): Record<string, unknown> {
  const width = Number(snapshot['viewport_width'] ?? 0)
  const height = Number(snapshot['viewport_height'] ?? 0)
  return {
    id: snapshot['snapshot_id'] ?? snapshot['capture_id'],
    captureRequestId: snapshot['capture_id'],
    scanId: snapshot['scan_id'],
    scanPageId: snapshot['page_id'],
    status: snapshot['status'],
    createdAt: snapshot['captured_at'],
    finalUrl: snapshot['final_url'],
    viewport: `${width} × ${height}`,
    viewportWidth: width,
    viewportHeight: height,
    measurementProfile: snapshot['measurement_profile'],
    browserVersion: snapshot['browser_version'],
    resourceCount: Number(snapshot['network_request_count'] ?? 0),
    capturedResourceCount: Number(snapshot['captured_resource_count'] ?? 0),
    totalBytes: Number(snapshot['total_transfer_bytes'] ?? 0),
    rendered: snapshot['rendered_metadata'] ?? null,
    diff: snapshot['diff_summary'] ?? null,
    performance: snapshot['performance_summary'] ?? null,
    artifacts: snapshot['snapshot_id'] ? {
      renderedHtmlBytes: Number(snapshot['html_bytes'] ?? 0),
      screenshotBytes: Number(snapshot['screenshot_bytes'] ?? 0),
    } : null,
    reconstruction: reconstructionResponse(snapshot),
    resources,
  }
}

function reconstructionResponse(source: Record<string, unknown>): Record<string, unknown> | null {
  if (!source['reconstruction_id']) return null
  return {
    id: source['reconstruction_id'],
    status: source['reconstruction_status'],
    kind: source['reconstruction_kind'],
    engineVersion: source['engine_version'],
    packagedCount: Number(source['packaged_count'] ?? 0),
    skippedCount: Number(source['skipped_count'] ?? 0),
    archiveBytes: source['archive_bytes'] === null ? null : Number(source['archive_bytes']),
    completenessCode: source['completeness_code'],
    failureCode: source['failure_code'],
    expiresAt: source['reconstruction_expires_at'],
    downloadAvailable: source['reconstruction_download_available'] === true,
  }
}

function parseEnvelope(value: unknown): CaptureCommandEnvelope {
  if (!value || typeof value !== 'object') throw new Error('INVALID_COMMAND')
  const envelope = value as Partial<CaptureCommandEnvelope>
  const payload = envelope.payload
  if (envelope.aggregateType !== 'CAPTURE' || envelope.messageType !== 'CAPTURE_REQUESTED'
    || envelope.contractVersion !== 1 || !payload || envelope.aggregateId !== payload.captureRequestId
    || typeof envelope.messageId !== 'string' || typeof envelope.correlationId !== 'string'
    || typeof payload.targetUrl !== 'string' || payload.measurementProfile !== 'desktop-lab-v1'
    || payload.viewportWidth !== 1365 || payload.viewportHeight !== 768
    || payload.timeoutSeconds !== 30 || payload.maxNetworkRequests < 1 || payload.maxNetworkRequests > 500
    || payload.maxResourceBodies < 0 || payload.maxResourceBodies > 100
    || payload.maxTotalBytes < 1 || payload.maxTotalBytes > 52_428_800
    || payload.maxResourceBytes < 1 || payload.maxResourceBytes > 10_485_760) {
    throw new Error('INVALID_COMMAND')
  }
  return envelope as CaptureCommandEnvelope
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxCommandBytes) throw new Error('INVALID_COMMAND_TOO_LARGE')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('INVALID_COMMAND')
  }
}

function authenticated(request: IncomingMessage, expected: string): boolean {
  const supplied = String(request.headers['x-weblens-service-token'] ?? '')
  const actualHash = createHash('sha256').update(supplied).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return supplied.length > 0 && timingSafeEqual(actualHash, expectedHash)
}

function setHeaders(response: ServerResponse): void {
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status)
  response.end(JSON.stringify(value))
}

function ensureNotExpired(reference: ScreenshotReference): void {
  if (reference.expiresAt.getTime() <= Date.now()) throw new Error('ARTIFACT_EXPIRED')
}

function verifyArtifact(value: Buffer, reference: ScreenshotReference): Buffer {
  if (value.length !== reference.bytes) throw new Error('ARTIFACT_SIZE_MISMATCH')
  if (!/^[0-9a-f]{64}$/u.test(reference.sha256Hex)) throw new Error('ARTIFACT_HASH_MISMATCH')
  const actual = createHash('sha256').update(value).digest()
  const expected = Buffer.from(reference.sha256Hex, 'hex')
  if (!timingSafeEqual(actual, expected)) throw new Error('ARTIFACT_HASH_MISMATCH')
  return value
}

function binary(
  response: ServerResponse,
  status: number,
  value: Buffer,
  sha256Hex: string,
  contentType: string,
  contentDisposition: string,
): void {
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', value.length)
  response.setHeader('Content-Disposition', contentDisposition)
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('ETag', `"sha256-${sha256Hex}"`)
  response.writeHead(status)
  response.end(value)
}

function problem(response: ServerResponse, status: number, code: string): void {
  json(response, status, { type: 'about:blank', title: code, status, code })
}
