import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeResourceMetadata } from './analytics.js'

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
