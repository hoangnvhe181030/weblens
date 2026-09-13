import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttpUrl, isPrivateAddress } from './security.js'

test('chặn địa chỉ private, loopback, link-local và multicast', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false)
})

test('chỉ chấp nhận HTTP(S) công khai không có userinfo', async () => {
  await assert.rejects(assertPublicHttpUrl('file:///etc/passwd'), /URL_POLICY_REJECTED/u)
  await assert.rejects(assertPublicHttpUrl('http://user:pass@example.com'), /URL_POLICY_REJECTED/u)
  await assert.rejects(assertPublicHttpUrl('http://localhost:8080'), /SSRF_BLOCKED/u)
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1'), /SSRF_BLOCKED/u)
})
