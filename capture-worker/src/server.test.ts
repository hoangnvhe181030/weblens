import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Config } from './config.js'
import type { CaptureDatabase } from './database.js'
import { startServer } from './server.js'

const token = 'capture-worker-test-token-at-least-32-bytes'
const ownerId = '11111111-1111-1111-1111-111111111111'
const captureId = '22222222-2222-2222-2222-222222222222'
const resourceId = '33333333-3333-3333-3333-333333333333'
const reconstructionId = '44444444-4444-4444-4444-444444444444'

test('chỉ trả artifact qua service token, owner scope và kiểm tra integrity', async () => {
  const screenshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const resource = Buffer.from('<script>untrusted()</script>', 'utf8')
  const archive = Buffer.from('PK\u0003\u0004static-clone', 'binary')
  const expiresAt = new Date(Date.now() + 60_000)
  let corruptResource = false
  let archiveState: 'PUBLISHED' | 'DELETE_PENDING' = 'PUBLISHED'
  const database = {
    ping: async () => undefined,
    acceptCommand: async () => false,
    getSnapshot: async () => null,
    getReconstruction: async (requestedOwnerId: string, requestedCaptureId: string) => (
      requestedOwnerId === ownerId && requestedCaptureId === captureId
        ? {
            reconstruction_id: reconstructionId,
            reconstruction_status: 'PARTIAL',
            reconstruction_kind: 'STATIC_PAGE_ARCHIVE',
            engine_version: 'test-engine',
            packaged_count: 2,
            skipped_count: 1,
            archive_bytes: archive.length,
            completeness_code: 'RESOURCE_GAPS',
            failure_code: null,
            reconstruction_expires_at: expiresAt,
            reconstruction_download_available: true,
          }
        : null
    ),
    getReconstructionArchiveReference: async (requestedOwnerId: string, requestedReconstructionId: string) => (
      requestedOwnerId === ownerId && requestedReconstructionId === reconstructionId
        ? {
            bucket: 'captures', key: 'owner/capture/clone.zip', bytes: archive.length,
            sha256Hex: createHash('sha256').update(archive).digest('hex'), expiresAt, state: archiveState,
          }
        : null
    ),
    getScreenshotReference: async (requestedOwnerId: string, requestedCaptureId: string) => {
      if (requestedOwnerId !== ownerId || requestedCaptureId !== captureId) return null
      return {
        bucket: 'captures', key: 'owner/capture/screenshot.jpg', bytes: screenshot.length,
        sha256Hex: createHash('sha256').update(screenshot).digest('hex'), expiresAt,
      }
    },
    getResourceReference: async (
      requestedOwnerId: string,
      requestedCaptureId: string,
      requestedResourceId: string,
    ) => {
      if (requestedOwnerId !== ownerId || requestedCaptureId !== captureId || requestedResourceId !== resourceId) {
        return null
      }
      return {
        bucket: 'captures', key: 'owner/capture/resource.bin', contentType: 'application/javascript',
        bytes: resource.length, sha256Hex: createHash('sha256').update(resource).digest('hex'), expiresAt,
      }
    },
  } satisfies Pick<
    CaptureDatabase,
    'ping' | 'acceptCommand' | 'getSnapshot' | 'getScreenshotReference' | 'getResourceReference'
    | 'getReconstruction' | 'getReconstructionArchiveReference'
  >
  const analytics = { ping: async () => undefined, listResources: async () => [] }
  const storage = {
    get: async (bucket: string, key: string) => {
      assert.equal(bucket, 'captures')
      if (key === 'owner/capture/screenshot.jpg') return screenshot
      if (key === 'owner/capture/clone.zip') return archive
      assert.equal(key, 'owner/capture/resource.bin')
      return corruptResource ? Buffer.from('corrupt', 'utf8') : resource
    },
  }
  const server = startServer(config(), database, analytics, storage)
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const path = `/internal/v1/reports/captures/${captureId}/artifacts/screenshot?ownerId=${ownerId}`

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}${path}`)
    assert.equal(unauthorized.status, 401)

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.equal(response.headers.get('etag'), `"sha256-${createHash('sha256').update(screenshot).digest('hex')}"`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), screenshot)

    const resourcePath = `/internal/v1/reports/captures/${captureId}/resources/${resourceId}/content?ownerId=${ownerId}`
    const resourceResponse = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(resourceResponse.status, 200)
    assert.equal(resourceResponse.headers.get('content-type'), 'application/octet-stream')
    assert.match(resourceResponse.headers.get('content-disposition') ?? '', /^attachment;/u)
    assert.equal(resourceResponse.headers.get('cache-control'), 'no-store')
    assert.equal(resourceResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await resourceResponse.arrayBuffer()), resource)

    const reconstructionResponse = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/captures/${captureId}/reconstruction?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(reconstructionResponse.status, 200)
    assert.deepEqual(await reconstructionResponse.json(), {
      id: reconstructionId,
      status: 'PARTIAL',
      kind: 'STATIC_PAGE_ARCHIVE',
      engineVersion: 'test-engine',
      packagedCount: 2,
      skippedCount: 1,
      archiveBytes: archive.length,
      completenessCode: 'RESOURCE_GAPS',
      failureCode: null,
      expiresAt: expiresAt.toISOString(),
      downloadAvailable: true,
    })

    const archiveResponse = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/reconstructions/${reconstructionId}/artifacts/archive?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(archiveResponse.status, 200)
    assert.equal(archiveResponse.headers.get('content-type'), 'application/zip')
    assert.match(archiveResponse.headers.get('content-disposition') ?? '', /^attachment;/u)
    assert.equal(archiveResponse.headers.get('cache-control'), 'no-store')
    assert.equal(archiveResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await archiveResponse.arrayBuffer()), archive)

    archiveState = 'DELETE_PENDING'
    const deletingArchive = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/reconstructions/${reconstructionId}/artifacts/archive?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(deletingArchive.status, 410)
    archiveState = 'PUBLISHED'

    const wrongOwner = await fetch(`http://127.0.0.1:${port}${resourcePath.replace(ownerId, captureId)}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(wrongOwner.status, 404)

    expiresAt.setTime(Date.now() - 1)
    const expired = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(expired.status, 410)
    assert.equal((await expired.json() as { code: string }).code, 'CAPTURE_ARTIFACT_GONE')

    expiresAt.setTime(Date.now() + 60_000)
    corruptResource = true
    const corrupted = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(corrupted.status, 503)
    assert.equal((await corrupted.json() as { code: string }).code, 'CAPTURE_ARTIFACT_INTEGRITY_FAILED')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

function config(): Config {
  return {
    port: 0,
    serviceToken: token,
    databaseUrl: 'postgresql://unused',
    clickhouseUrl: 'http://unused',
    clickhouseDatabase: 'unused',
    clickhouseUsername: 'unused',
    clickhousePassword: 'unused',
    s3Endpoint: 'http://unused',
    s3Region: 'unused',
    s3AccessKey: 'unused',
    s3SecretKey: 'unused',
    s3Bucket: 'captures',
    controlEventUrl: 'http://unused',
    concurrency: 1,
    workerPollMillis: 100,
    analyticsPollMillis: 100,
    eventPollMillis: 100,
    reconstructionGcPollMillis: 1_000,
  }
}
