import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CaptureAnalytics, mergeResourceMetadata } from './analytics.js'
import type { Config } from './config.js'

test('readiness rejects a failed ClickHouse ping result', async () => {
  const analytics = new CaptureAnalytics({ clickhouseUrl: 'http://127.0.0.1:1',
    clickhouseUsername: 'test', clickhousePassword: 'test', clickhouseDatabase: 'default' } as Config)
  try {
    const client = (analytics as unknown as { client: { ping: () => Promise<unknown> } }).client
    client.ping = async () => ({ success: false, error: new Error('connection refused') })
    await assert.rejects(analytics.ping(), /CLICKHOUSE_UNAVAILABLE/u)
    client.ping = async () => ({ success: true })
    await analytics.ping()
  } finally { await analytics.close() }
})

test('resource reads consume each response before acquiring the sole connection', { timeout: 5000 }, async () => {
  const queries: string[] = []
  let failCapturedQuery = false
  const server = createServer(async (request, response) => {
    let query = ''
    for await (const chunk of request) query += chunk.toString()
    queries.push(query)
    response.setHeader('Content-Type', 'application/x-ndjson')
    if (query.includes('from network_requests')) {
      // Exceed stream buffers so an unread response cannot release its socket.
      response.end(Array.from({ length: 500 }, (_, index) => JSON.stringify({
        id: `request-${index}`, requestSequence: index, url: `https://example.test/${'a'.repeat(4096)}`,
        method: 'GET', status: 200, type: 'script', contentType: 'application/javascript',
        sizeBytes: 100, durationMs: 2,
      })).join('\n') + '\n')
    } else {
      if (failCapturedQuery) {
        response.statusCode = 500
        response.end('fixture resource error')
        return
      }
      response.end(JSON.stringify({ capturedBodyId: 'body-0', requestSequence: 0,
        capturedBodyBytes: 100, bodySha256: 'a'.repeat(64), bodyTruncated: 0 }) + '\n')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const analytics = new CaptureAnalytics({
    clickhouseUrl: `http://127.0.0.1:${address.port}?max_open_connections=1&request_timeout=1000&log_level=OFF`,
    clickhouseUsername: 'test', clickhousePassword: 'test', clickhouseDatabase: 'default',
  } as Config)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const resources = await Promise.race([
      analytics.listResources('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('resource pool stalled')), 2000) }),
    ])
    assert.equal(resources.length, 500)
    assert.equal(resources[0]?.capturedBodyId, 'body-0')
    assert.equal(resources[1]?.bodyCaptured, false)
    assert.equal(queries.length, 2)
    assert.match(queries[0]!, /owner_id=\{owner:UUID\} and capture_request_id=\{capture:UUID\}/u)
    assert.match(queries[1]!, /from captured_resources/u)
    failCapturedQuery = true
    await assert.rejects(analytics.listResources('11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222'), /fixture resource error/u)
    failCapturedQuery = false
    assert.equal((await analytics.listResources('11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222')).length, 500)
    assert.equal(queries.length, 6, 'query failure must not retain the sole connection')
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => analytics.listResources(
      '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')))
    assert.ok(concurrent.every(resources => resources.length === 500))
    assert.equal(queries.length, 16, 'concurrent reports must share the bounded pool without stalling')
  } finally {
    clearTimeout(deadline)
    await analytics.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('ghép network request với captured body theo request sequence', () => {
  const resources = mergeResourceMetadata([
    {
      id: 'request-1', requestSequence: 7, url: 'https://example.com/app.js', method: 'GET',
      status: 200, type: 'script', contentType: 'application/javascript', sizeBytes: 120, durationMs: 9,
    },
    {
      id: 'request-2', requestSequence: 8, url: 'https://example.com/api', method: 'POST',
      status: 204, type: 'fetch', contentType: 'application/json', sizeBytes: 0, durationMs: 15,
    },
  ], [{
    capturedBodyId: 'body-1', requestSequence: 7, capturedBodyBytes: 100,
    bodySha256: 'a'.repeat(64), bodyTruncated: 1,
  }])

  assert.deepEqual(resources[0], {
    id: 'request-1', url: 'https://example.com/app.js', method: 'GET', status: 200,
    type: 'script', contentType: 'application/javascript', sizeBytes: 120, durationMs: 9,
    bodyCaptured: true, capturedBodyId: 'body-1', capturedBodyBytes: 100,
    bodySha256: 'a'.repeat(64), bodyTruncated: true,
  })
  assert.equal(resources[1]?.bodyCaptured, false)
  assert.equal(resources[1]?.capturedBodyId, null)
})
