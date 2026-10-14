#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const loadDirectory = fileURLToPath(new URL('./', import.meta.url))
const websiteId = '018f0f00-0000-7000-8000-000000000001'
const mismatchedWebsiteId = '018f0f00-0000-7000-8000-000000000003'
const scanId = '018f0f00-0000-7000-8000-000000000002'
const pageId = '018f0f00-0000-7000-8000-000000000004'
const captureId = '018f0f00-0000-7000-8000-000000000005'
const snapshotId = '018f0f00-0000-7000-8000-000000000006'
const userId = '018f0f00-0000-7000-8000-000000000007'
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
    '--base-path', '/__weblens-load',
  ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  const fixtureReady = await firstJsonLine(fixture)
  assert.equal(fixtureReady.event, 'fixture_ready')

  const fixtureOrigin = new URL(fixtureReady.url).origin
  for (const path of ['/', '/page/1', '/__fixture/health', '/robots.txt', '/__weblens-load-other/page/1']) {
    const response = await fetch(`${fixtureOrigin}${path}`)
    assert.equal(response.status, 404, `fixture exposed ${path} outside its prefix`)
  }
  const outsidePost = await fetch(`${fixtureOrigin}/page/1`, { method: 'POST' })
  assert.equal(outsidePost.status, 404)
  const fixtureRoot = await fetch(fixtureReady.url)
  assert.equal(fixtureRoot.status, 200)
  const fixtureHtml = await fixtureRoot.text()
  assert.match(fixtureHtml, /href="\/__weblens-load\/page\/1"/)
  assert.match(fixtureHtml, /rel="canonical" href="\/__weblens-load\/"/)

  const controlState = { scanCreateCount: 0, captureCreateCount: 0, websiteCreated: false, loginCount: 0 }
  const controlPlane = await listen(createControlPlane(fixtureReady.url, controlState))
  const crawler = await listen(createHealthServer())
  servers.push(controlPlane.server, crawler.server)

  await abortFixtureResponse(`${fixtureReady.url}page/1`)
  const fixtureAfterAbort = await getJson(`${fixtureReady.url}__fixture/health`)
  assert.equal(fixtureAfterAbort.status, 'UP')

  const api = await runHarness([
    'api',
    '--base-url', fixtureReady.url,
    '--health-path', '/__weblens-load/__fixture/health',
    '--path', '/__weblens-load/page/1',
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

  if (process.platform === 'win32') {
    const preflight = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', `${loadDirectory}preflight-production.ps1`,
      '-BaseUrl', controlPlane.url,
      '-TargetUrl', `${controlPlane.url}__weblens-load/page/999`,
      '-ControlPlaneHealthUrl', `${controlPlane.url}actuator/health`,
      '-CrawlerHealthUrl', `${controlPlane.url}actuator/health`,
      '-CaptureHealthUrl', `${controlPlane.url}actuator/health`,
      '-OutputDirectory', fileURLToPath(new URL('../../tmp/load/preflight-smoke', import.meta.url)),
      '-TimeoutSeconds', '30',
      '-AllowLoopbackForSmoke',
    ], { WEBLENS_LOAD_PASSWORD: 'smoke-password-never-log' })
    assert.equal(preflight.code, 0, preflight.stderr)
    const preflightResult = lastJsonLine(preflight.stdout)
    assert.equal(preflightResult.outcome, 'COMPLETED')
    assert.equal(preflightResult.processedPages, 1)
    assert.equal(preflightResult.captureStatus, 'COMPLETED')
    assert.equal(preflight.stdout.includes('smoke-password-never-log'), false)
    assert.equal(preflight.stderr.includes('smoke-password-never-log'), false)

    const resumed = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${loadDirectory}preflight-production.ps1`,
      '-BaseUrl', controlPlane.url,
      '-TargetUrl', `${controlPlane.url}__weblens-load/page/999`,
      '-ControlPlaneHealthUrl', `${controlPlane.url}actuator/health`,
      '-CrawlerHealthUrl', `${controlPlane.url}actuator/health`,
      '-CaptureHealthUrl', `${controlPlane.url}actuator/health`,
      '-OutputDirectory', fileURLToPath(new URL('../../tmp/load/preflight-smoke', import.meta.url)),
      '-TimeoutSeconds', '30', '-ResumeLatest', '-AllowLoopbackForSmoke',
    ], { WEBLENS_LOAD_PASSWORD: 'smoke-password-never-log' })
    assert.equal(resumed.code, 0, resumed.stderr)
    const resumedResult = lastJsonLine(resumed.stdout)
    assert.equal(resumedResult.scanReused, true)
    assert.equal(resumedResult.captureReused, true)
    assert.equal(controlState.scanCreateCount, 2)
    assert.equal(controlState.captureCreateCount, 1)
  }

  const renewedCrawl = await runHarness([
    'crawl', '--base-url', controlPlane.url,
    '--crawler-health-url', `${crawler.url}health/ready`,
    '--fixture-url', fixtureReady.url,
    '--pages', '1', '--website-id', websiteId,
    '--timeout', '5s', '--poll-interval', '100ms', '--request-timeout', '2s',
    '--email', 'benchmark@example.test',
  ], { WEBLENS_LOAD_PASSWORD: 'smoke-password-never-log' })
  assert.equal(renewedCrawl.code, 0, renewedCrawl.stderr)
  assert.equal(lastJsonLine(renewedCrawl.stdout).outcome, 'COMPLETED')
  assert.equal(controlState.loginCount, 2, 'access token should renew before expiration')
  assert.equal(renewedCrawl.stdout.includes('smoke-password-never-log'), false)
  assert.equal(renewedCrawl.stderr.includes('smoke-password-never-log'), false)

  process.stdout.write(`${JSON.stringify({
    event: 'load_smoke_passed', apiOperations: 40, crawlExpectedPages: 40,
    productionPreflight: process.platform === 'win32' ? 'passed' : 'skipped_non_windows',
  })}\n`)
} finally {
  fixture?.kill('SIGTERM')
  await Promise.allSettled(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}

function createControlPlane(fixtureUrl, state) {
  let progressReads = 0
  let loginToken = null
  return http.createServer((request, response) => {
    response.sendDate = false
    if (request.method === 'GET' && request.url === '/actuator/health') {
      writeJson(response, 200, { status: 'UP' })
      return
    }
    if (request.method === 'GET' && request.url === '/__weblens-load/__fixture/health') {
      writeJson(response, 200, { status: 'UP', pageCount: 1000 })
      return
    }
    if (request.method === 'POST' && request.url === '/api/v1/auth/registrations') {
      writeJson(response, 201, {
        user: { id: userId }, accessToken: 'smoke-token-never-log', tokenType: 'Bearer',
      })
      return
    }
    if (request.method === 'POST' && request.url === '/api/v1/auth/sessions') {
      state.loginCount += 1
      const expiry = Math.floor(Date.now() / 1000) + (state.loginCount === 1 ? 30 : 3600)
      loginToken = `smoke.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`
      writeJson(response, 200, { accessToken: loginToken, tokenType: 'Bearer' })
      return
    }
    if (request.headers.authorization !== 'Bearer smoke-token-never-log' &&
        request.headers.authorization !== `Bearer ${loginToken}`) {
      writeJson(response, 401, { code: 'UNAUTHORIZED' })
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/websites?page=')) {
      writeJson(response, 200, {
        items: state.websiteCreated ? [{
          id: websiteId,
          canonicalUrl: `${controlUrl(request)}/__weblens-load/page/999`,
          latestScan: { id: scanId, status: 'COMPLETED' },
        }] : [],
      })
      return
    }
    if (request.method === 'POST' && request.url === '/api/v1/websites') {
      state.websiteCreated = true
      writeJson(response, 201, {
        id: websiteId, canonicalUrl: `${controlUrl(request)}/__weblens-load/page/999`,
      })
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
      writeJson(response, 200, scanResponse('COMPLETED', state.scanCreateCount > 1 ? 1 : 40))
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/scans/${scanId}/pages?limit=10`) {
      writeJson(response, 200, {
        fresh: true,
        items: [{
          id: pageId, url: `${controlUrl(request)}/__weblens-load/page/999`, statusCode: 200,
          outcome: 'success', responseTimeMs: 4, responseBytes: 4096,
        }],
        summary: { totalUrlCount: 1, issuePageCount: 0, findingCount: 0, status2xxCount: 1 },
      })
      return
    }
    if (request.method === 'POST' && request.url === `/api/v1/scan-pages/${pageId}/captures`) {
      state.captureCreateCount += 1
      writeJson(response, 202, captureResponse())
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/scans/${scanId}/scan-pages/${pageId}/captures/latest-ready`) {
      writeJson(response, 200, captureResponse())
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/captures/${captureId}`) {
      writeJson(response, 200, captureResponse())
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/captures/${captureId}/snapshot`) {
      writeJson(response, 200, {
        id: snapshotId, captureRequestId: captureId, scanId, scanPageId: pageId,
        finalUrl: `${controlUrl(request)}/__weblens-load/page/999`, browserVersion: 'smoke-browser',
        resourceCount: 1, capturedResourceCount: 1, totalBytes: 4096,
        reconstruction: { id: snapshotId, status: 'PUBLISHED', downloadAvailable: false },
      })
      return
    }
    if (request.method === 'GET' && request.url === `/api/v1/captures/${captureId}/artifacts/screenshot`) {
      if (request.headers.accept !== 'image/jpeg') {
        writeJson(response, 406, { code: 'NOT_ACCEPTABLE' })
        return
      }
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      response.statusCode = 200
      response.setHeader('Content-Type', 'image/jpeg')
      response.setHeader('Content-Length', String(jpeg.length))
      response.end(jpeg)
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

  function captureResponse() {
    return {
      id: captureId, scanId, pageId, status: 'COMPLETED', objectCount: 2,
      totalObjectBytes: 4100, terminalCode: null,
    }
  }
}

function controlUrl(request) {
  return `http://${request.headers.host}`
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
