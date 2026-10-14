import assert from 'node:assert/strict'
import { Socket, connect } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import http, { type RequestOptions, type IncomingMessage } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { SafeProxy } from './safe-proxy.js'

test('HTTP forwarding strips proxy-connection and preserves the pinned destination, Host and body', async (t) => {
  const received: { path: string | undefined; host: string | undefined; proxyConnection: string | undefined; body: string }[] = []
  const origin = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString() })
    request.on('end', () => {
      received.push({ path: request.url, host: request.headers.host,
        proxyConnection: request.headers['proxy-connection'] as string | undefined, body })
      response.end('fixture response')
    })
  })
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  const address = origin.address()
  assert.ok(address && typeof address !== 'string')
  const nativeRequest = http.request
  // Only replace the transport destination; URL/DNS policy and Node header validation remain real.
  t.mock.method(http, 'request', (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(options.hostname, '8.8.8.8')
    assert.equal(options.port, 9090)
    return nativeRequest({ ...options, hostname: '127.0.0.1', port: address.port }, callback)
  })
  syncBuiltinESMExports()
  const proxy = new SafeProxy()
  await proxy.start()
  try {
    for (const headers of [{ host: 'ignored.invalid' }, { host: 'ignored.invalid', 'proxy-connection': 'keep-alive' }]) {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = nativeRequest({ hostname: '127.0.0.1', port: Number(new URL(proxy.url()).port),
          method: 'POST', path: 'http://8.8.8.8:9090/example?q=fixture', headers }, response => {
          let body = ''
          response.on('data', chunk => { body += chunk.toString() })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
          response.on('error', reject)
        })
        request.on('error', reject)
        request.setTimeout(2000, () => request.destroy(new Error('fixture timeout')))
        request.end('test payload')
      })
      assert.deepEqual(result, { status: 200, body: 'fixture response' })
    }
    assert.deepEqual(received, Array.from({ length: 2 }, () => ({ path: '/example?q=fixture',
      host: '8.8.8.8:9090', proxyConnection: undefined, body: 'test payload' })))
  } finally {
    await proxy.close()
    await new Promise<void>(resolve => origin.close(() => resolve()))
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('proxy closes open connections during shutdown and enforces transport bytes', async () => {
  const proxy = new SafeProxy(1024)
  await proxy.start()
  const client = connect({ host: '127.0.0.1', port: Number(new URL(proxy.url()).port) })
  await once(client, 'connect')
  const upstream = new Socket()
  Reflect.get(proxy, 'track').call(proxy, upstream, true)
  upstream.emit('data', Buffer.alloc(1025))
  assert.throws(() => proxy.assertWithinBudget(), /CAPTURE_TRANSFER_BUDGET_EXCEEDED/u)
  assert.equal(upstream.destroyed, true)
  await proxy.close()
  client.destroy()
})
