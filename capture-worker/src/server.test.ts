import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Config } from './config.js'
import type { CaptureDatabase } from './database.js'
import { startServer } from './server.js'

const token = 'capture-worker-test-token-at-least-32-bytes'
const ownerId = '11111111-1111-1111-1111-111111111111'
const captureId = '22222222-2222-2222-2222-222222222222'

test('chỉ trả screenshot qua service token và owner scope', async () => {
  const screenshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const database = {
    ping: async () => undefined,
    acceptCommand: async () => false,
    getSnapshot: async () => null,
    getScreenshotReference: async (requestedOwnerId: string, requestedCaptureId: string) => {
      if (requestedOwnerId !== ownerId || requestedCaptureId !== captureId) return null
      return { bucket: 'captures', key: 'owner/capture/screenshot.jpg', bytes: screenshot.length, sha256Hex: 'abc123' }
    },
  } satisfies Pick<CaptureDatabase, 'ping' | 'acceptCommand' | 'getSnapshot' | 'getScreenshotReference'>
  const analytics = { ping: async () => undefined, listResources: async () => [] }
  const storage = {
    get: async (bucket: string, key: string) => {
      assert.equal(bucket, 'captures')
      assert.equal(key, 'owner/capture/screenshot.jpg')
      return screenshot
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
    assert.equal(response.headers.get('etag'), '"sha256-abc123"')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), screenshot)
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
  }
}
