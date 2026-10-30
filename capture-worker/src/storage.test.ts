import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { ObjectStorage } from './storage.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { LeaseAttempt } from './lease-attempt.js'
import type { Config } from './config.js'

test('artifact spool enforces actual bytes without Content-Length and removes its temporary file', async () => {
  const storage = new ObjectStorage({ s3Endpoint: 'http://127.0.0.1:1', s3Region: 'us-east-1',
    s3AccessKey: 'test', s3SecretKey: 'test', s3Bucket: 'test' } as Config)
  const client = Reflect.get(storage, 'client') as { send: () => Promise<unknown>; destroy: () => void }
  try {
    client.send = async () => ({ Body: Readable.from([Buffer.alloc(1025)]) })
    await assert.rejects(storage.downloadFile('test', 'key', 1024), /ARTIFACT_SIZE_MISMATCH/u)
    client.send = async () => ({ Body: Readable.from([Buffer.from('evidence')]) })
    const file = await storage.downloadFile('test', 'key', 1024)
    assert.equal(file.bytes, 8)
    assert.equal(file.sha256Hex, createHash('sha256').update('evidence').digest('hex'))
    assert.equal((await readFile(file.path)).toString(), 'evidence')
    await file.cleanup()
    await assert.rejects(access(file.path))
  } finally { client.destroy() }
})

test('a storage peer that never replies cannot retain a healthy capture lease', async () => {
  const server = createServer(() => { /* accept the request without replying */ })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const storage = new ObjectStorage({ s3Endpoint: `http://127.0.0.1:${address.port}`, s3Region: 'us-east-1',
    s3AccessKey: 'test', s3SecretKey: 'test', s3Bucket: 'test', storageRequestTimeoutMillis: 5000 } as Config)
  const attempt = new LeaseAttempt(100, async () => true, 10)
  try {
    await assert.rejects(storage.put('key', Buffer.from('evidence'), 'text/plain', attempt.signal))
    assert.throws(() => attempt.check(), /WORKER_ATTEMPT_TIMEOUT/u)
  } finally {
    attempt.close()
    ;(Reflect.get(storage, 'client') as { destroy: () => void }).destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('storage request deadline includes a response body that stops streaming', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.write('partial')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const storage = new ObjectStorage({ s3Endpoint: `http://127.0.0.1:${address.port}`, s3Region: 'us-east-1',
    s3AccessKey: 'test', s3SecretKey: 'test', s3Bucket: 'test', storageRequestTimeoutMillis: 100 } as Config)
  try {
    await assert.rejects(storage.get('test', 'key'))
  } finally {
    ;(Reflect.get(storage, 'client') as { destroy: () => void }).destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
