import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sanitizeUrl } from './capture.js'

test('redact toàn bộ query value và loại userinfo, fragment khỏi URL analytical', () => {
  const sanitized = sanitizeUrl(
    'https://user:password@example.com/app.js?token=secret&lang=vi&lang=en#private-fragment',
  )
  const url = new URL(sanitized)

  assert.equal(url.username, '')
  assert.equal(url.password, '')
  assert.equal(url.hash, '')
  assert.deepEqual(url.searchParams.getAll('token'), ['[REDACTED]'])
  assert.deepEqual(url.searchParams.getAll('lang'), ['[REDACTED]'])
})
