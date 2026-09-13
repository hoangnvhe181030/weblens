#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const loadDirectory = fileURLToPath(new URL('./', import.meta.url))
const websiteId = '018f0f00-0000-7000-8000-000000000001'
const mismatchedWebsiteId = '018f0f00-0000-7000-8000-000000000003'
const scanId = '018f0f00-0000-7000-8000-000000000002'
const servers = []
let fixture

try {
  fixture = spawn(process.execPath, [
    `${loadDirectory}fixture.mjs`,
    '--port', '0',
    '--pages', '40',
    '--fanout', '4',
    '--delay', '1ms',
    '--body-bytes', '65536',
  ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  const fixtureReady = await firstJsonLine(fixture)
  assert.equal(fixtureReady.event, 'fixture_ready')

  const controlState = { scanCreateCount: 0 }
  const controlPlane = await listen(createControlPlane(fixtureReady.url, controlState))
  const crawler = await listen(createHealthServer())
  servers.push(controlPlane.server, crawler.server)

  await abortFixtureResponse(`${fixtureReady.url}page/1`)
  const fixtureAfterAbort = await getJson(`${fixtureReady.url}__fixture/health`)
  assert.equal(fixtureAfterAbort.status, 'UP')

  const api = await runHarness([
    'api',
    '--base-url', fixtureReady.url,
    '--health-path', '/__fixture/health',
    '--path', '/page/1',
    '--virtual-users', '4',
    '--operations', '40',
    '--request-timeout', '2s',
    '--report-interval', '250ms',
  ])
  assert.equal(api.code, 0, api.stderr)
  assert.equal(lastJsonLine(api.stdout).outcome, 'COMPLETED')

  const mismatch = await runHarness([
    'crawl',
    '--base-url', controlPlane.url,
    '--crawler-health-url', `${crawler.url}health/ready`,
    '--fixture-url', fixtureReady.url,
    '--pages', '40',
    '--website-id', mismatchedWebsiteId,
    '--timeout', '5s',
    '--poll-interval', '100ms',
    '--request-timeout', '2s',
  ], { WEBLENS_LOAD_ACCESS_TOKEN: 'smoke-token-never-log' })
  assert.equal(mismatch.code, 1)
  assert.match(mismatch.stderr, /load_failed/)
  assert.equal(controlState.scanCreateCount, 0, 'mismatched website must not create a scan')

  const crawl = await runHarness([
    'crawl',
    '--base-url', controlPlane.url,
    '--crawler-health-url', `${crawler.url}health/ready`,
    '--fixture-url', fixtureReady.url,
    '--pages', '40',
    '--website-id', websiteId,
    '--timeout', '5s',
    '--poll-interval', '100ms',
    '--request-timeout', '2s',
  ], { WEBLENS_LOAD_ACCESS_TOKEN: 'smoke-token-never-log' })
  assert.equal(crawl.code, 0, crawl.stderr)
  assert.equal(lastJsonLine(crawl.stdout).outcome, 'COMPLETED')
  assert.equal(controlState.scanCreateCount, 1)
  assert.equal(crawl.stdout.includes('smoke-token-never-log'), false)
  assert.equal(crawl.stderr.includes('smoke-token-never-log'), false)

  process.stdout.write(`${JSON.stringify({ event: 'load_smoke_passed', apiOperations: 40, crawlExpectedPages: 40 })}\n`)
} finally {
  fixture?.kill('SIGTERM')
  await Promise.allSettled(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}

function createControlPlane(fixtureUrl, state) {
  let progressReads = 0
  return http.createServer((request, response) => {
    response.sendDate = false
    if (request.method === 'GET' && request.url === '/actuator/health') {
      writeJson(response, 200, { status: 'UP' })
      return
    }
    if (request.headers.authorization !== 'Bearer smoke-token-never-log') {
      writeJson(response, 401, { code: 'UNAUTHORIZED' })
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/websites/${websiteId}`) {
      writeJson(response, 200, { id: websiteId, canonicalUrl: fixtureUrl })
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/websites/${mismatchedWebsiteId}`) {
      writeJson(response, 200, { id: mismatchedWebsiteId, canonicalUrl: 'http://127.0.0.1:1/' })
      return
    }
    if (request.method === 'POST' && request.url === `/api/v1/websites/${websiteId}/scans`) {
      state.scanCreateCount += 1
      writeJson(response, 202, scanResponse('QUEUED', 0))
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/scans/${scanId}`) {
      progressReads += 1
      writeJson(response, 200, scanResponse('COMPLETED', 40))
      return
    }
    writeJson(response, 404, { code: 'NOT_FOUND' })
  })

  function scanResponse(status, processed) {
    return {
      id: scanId,
      websiteId,
      status,
      progress: {
        discovered: processed,
        queued: 0,
        processed,
        succeeded: processed,
        failed: 0,
        limit: 40,
      },
      effectiveConfig: {
        maxPages: 40,
        maxDepth: 3,
        maxResponseBytes: 1048576,
        maxDurationSeconds: 300,
        maxRedirects: 5,
        concurrency: 4,
      },
      terminalReason: null,
      progressReads,
    }
  }
}

function createHealthServer() {
  return http.createServer((request, response) => {
    response.sendDate = false
    if (request.method === 'GET' && request.url === '/health/ready') {
      writeJson(response, 200, { status: 'UP' })
      return
    }
    writeJson(response, 404, { status: 'DOWN' })
  })
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.equal(typeof address, 'object')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

function runHarness(arguments_, extraEnvironment = {}) {
  return run(process.execPath, [`${loadDirectory}run.mjs`, ...arguments_], extraEnvironment)
}

function run(command, arguments_, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function firstJsonLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== null && buffer.length === 0) reject(new Error(`Fixture kết thúc sớm với exit code ${code}.`))
    })

    function onData(chunk) {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      child.stdout.off('data', onData)
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    }
  })
}

function lastJsonLine(output) {
  const lines = output.trim().split(/\r?\n/)
  return JSON.parse(lines.at(-1))
}

function writeJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', String(Buffer.byteLength(body)))
  response.end(body)
}

function abortFixtureResponse(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.once('data', () => {
        response.destroy()
        resolve()
      })
      response.once('error', (error) => {
        if (error.code === 'ECONNRESET') resolve()
        else reject(error)
      })
    })
    request.once('error', reject)
  })
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.once('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    }).once('error', reject)
  })
}
