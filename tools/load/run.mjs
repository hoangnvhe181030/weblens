#!/usr/bin/env node

import crypto from 'node:crypto'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import {
  assertKnownOptions,
  durationOption,
  flag,
  integerOption,
  parseCommandLine,
  requireExactlyOneLimit,
  stringOption,
} from './lib/cli.mjs'
import { jsonRequest, measuredRequest, RequestFailure, requireHealthy } from './lib/http.mjs'
import { Metrics, classifyRequestError } from './lib/metrics.mjs'
import { writeReport } from './lib/report.mjs'
import {
  enforceHighLoadAcknowledgement,
  enforceTargetScope,
  resolveSameOriginPath,
  sanitizedUrl,
  validatedHttpUrl,
} from './lib/safety.mjs'

const COMMON_OPTIONS = new Set([
  'base-url',
  'health-path',
  'request-timeout',
  'report-interval',
  'max-response-bytes',
  'acknowledge-high-load',
  'allow-non-loopback',
  'confirm-target-ownership',
  'help',
])

const API_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  'path',
  'method',
  'concurrency',
  'virtual-users',
  'operations',
  'duration',
  'email',
])

const CRAWL_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  'crawler-health-url',
  'fixture-url',
  'pages',
  'poll-interval',
  'timeout',
  'email',
  'website-id',
  'website-name',
  'plan-only',
  'cancel-on-timeout',
  'no-cancel-on-timeout',
])

const HELP = `
WebLens load harness (Node.js 24, không có dependency ngoài).

Cách dùng:
  node tools/load/run.mjs api [tùy chọn]
  node tools/load/run.mjs crawl [tùy chọn]

Scenario api:
  --base-url <url>          API origin (mặc định http://127.0.0.1:8080)
  --health-path <path>      Health preflight (mặc định /actuator/health)
  --path <path>             Endpoint GET/HEAD cần tải
  --method <GET|HEAD>       Mặc định GET
  --concurrency <n>         Số virtual user đồng thời, tối đa 100000
  --virtual-users <n>       Alias của --concurrency
  --operations <n>          Tổng operation hữu hạn
  --duration <duration>     Thời lượng hữu hạn, ví dụ 30s
  --email <email>           Login một tài khoản rồi dùng chung bearer token

Scenario crawl:
  --fixture-url <url>       Fixture local (mặc định http://127.0.0.1:9090/)
  --crawler-health-url <url> Readiness crawler (mặc định http://127.0.0.1:8081/health/ready)
  --pages <n>               Số trang kỳ vọng trong một scan, tối đa 100000
  --timeout <duration>      Thời gian chờ scan hữu hạn (bắt buộc khi chạy thật)
  --poll-interval <duration> Chu kỳ đọc tiến độ (mặc định 2s)
  --email <email>           Tài khoản WebLens; mật khẩu chỉ đọc từ WEBLENS_LOAD_PASSWORD
  --website-id <uuid>       Dùng website đã đăng ký thay vì tự tìm/tạo fixture
  --website-name <name>     Tên website fixture khi cần tạo
  --plan-only               Chỉ kiểm tra health/fixture và in kế hoạch, không login/tạo scan
  --no-cancel-on-timeout    Không yêu cầu hủy scan khi runner hết thời gian

Tùy chọn chung:
  --request-timeout <duration> Timeout mỗi HTTP request (mặc định 5s)
  --report-interval <duration> Chu kỳ in aggregate metrics (mặc định 5s)
  --max-response-bytes <n>  Giới hạn body API được đọc (mặc định 1048576)
  --acknowledge-high-load   Xác nhận tải lớn có thể làm máy kiểm thử sập
  --allow-non-loopback --confirm-target-ownership
                             Bắt buộc cùng nhau nếu target không phải loopback
  --help                    Hiện trợ giúp

Credential:
  WEBLENS_LOAD_PASSWORD     Mật khẩu login; không nhận mật khẩu qua CLI
  WEBLENS_LOAD_ACCESS_TOKEN Bearer token tùy chọn; không được ghi vào report/log
`

const startedAt = new Date()
const { command, options } = parseCommandLine(process.argv.slice(2))

if (flag(options, 'help') || command === undefined) {
  process.stdout.write(HELP)
  process.exit(command === undefined ? 1 : 0)
}

try {
  let report
  if (command === 'api') {
    assertKnownOptions(options, API_OPTIONS)
    report = await runApiScenario(options)
  } else if (command === 'crawl') {
    assertKnownOptions(options, CRAWL_OPTIONS)
    report = await runCrawlScenario(options)
  } else {
    throw new Error(`Scenario không được hỗ trợ: ${command}`)
  }
  const output = await writeReport(command, report)
  process.stdout.write(`${JSON.stringify({ event: 'load_complete', output, outcome: report.outcome })}\n`)
  if (report.outcome === 'FAILED') process.exitCode = 1
} catch (error) {
  const report = {
    schemaVersion: 1,
    scenario: command ?? 'unknown',
    outcome: 'FAILED',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    failure: safeFailure(error),
    generator: generatorProfile(),
  }
  const output = await writeReport(command ?? 'unknown', report)
  process.stderr.write(`${JSON.stringify({ event: 'load_failed', category: report.failure.category, output })}\n`)
  process.exitCode = 1
}

async function runApiScenario(rawOptions) {
  const common = commonConfig(rawOptions)
  const baseUrl = validatedHttpUrl(stringOption(rawOptions, 'base-url', 'http://127.0.0.1:8080'), '--base-url')
  const targetUrl = resolveSameOriginPath(baseUrl, stringOption(rawOptions, 'path', '/actuator/health'), '--path')
  const healthUrl = resolveSameOriginPath(baseUrl, stringOption(rawOptions, 'health-path', '/actuator/health'), '--health-path')
  const method = stringOption(rawOptions, 'method', 'GET').toUpperCase()
  if (!['GET', 'HEAD'].includes(method)) throw new Error('--method chỉ hỗ trợ GET hoặc HEAD để tránh gửi payload ngoài ý muốn.')

  if (rawOptions.has('concurrency') && rawOptions.has('virtual-users')) {
    throw new Error('Chỉ dùng một trong --concurrency hoặc --virtual-users.')
  }
  const concurrencyName = rawOptions.has('virtual-users') ? 'virtual-users' : 'concurrency'
  const concurrency = integerOption(rawOptions, concurrencyName, 10, { minimum: 1, maximum: 100_000 })
  const operationLimit = integerOption(rawOptions, 'operations', undefined, { minimum: 1, maximum: 1_000_000_000 })
  const durationMs = durationOption(rawOptions, 'duration', undefined, { minimum: 100, maximum: 24 * 60 * 60_000 })
  requireExactlyOneLimit(operationLimit, durationMs)
  enforceTargetScope([baseUrl, targetUrl, healthUrl], common.scope)
  enforceHighLoadAcknowledgement(
    { concurrency, operations: operationLimit, durationMs, bodyBytes: common.maxResponseBytes },
    flag(rawOptions, 'acknowledge-high-load'),
  )

  const preflight = await requireHealthy(healthUrl, common.requestTimeoutMs, 'Control Plane/API')
  const token = await optionalAuthentication(baseUrl, rawOptions, common.requestTimeoutMs)
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const metrics = new Metrics(common.requestTimeoutMs)
  const runStarted = performance.now()
  const deadline = durationMs === undefined ? Number.POSITIVE_INFINITY : runStarted + durationMs
  let nextOperation = 0

  const progressTimer = startProgressTimer(metrics, runStarted, common.reportIntervalMs, 'api_progress')
  const workerCount = Math.min(concurrency, operationLimit ?? concurrency)
  const workers = Array.from({ length: workerCount }, () => worker())
  await Promise.all(workers)
  clearInterval(progressTimer)

  const elapsedMs = Math.ceil(performance.now() - runStarted)
  const snapshot = metrics.snapshot(elapsedMs)
  return {
    schemaVersion: 1,
    scenario: 'api',
    outcome: snapshot.failed === 0 ? 'COMPLETED' : 'COMPLETED_WITH_ERRORS',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    generator: generatorProfile(),
    preflight,
    configuration: {
      endpoint: sanitizedUrl(targetUrl),
      healthEndpoint: sanitizedUrl(healthUrl),
      method,
      virtualUsers: concurrency,
      operationLimit: operationLimit ?? null,
      durationMs: durationMs ?? null,
      requestTimeoutMs: common.requestTimeoutMs,
      maxResponseBytes: common.maxResponseBytes,
      authentication: token ? 'bearer' : 'none',
    },
    elapsedMs,
    metrics: snapshot,
  }

  async function worker() {
    while (performance.now() < deadline) {
      if (operationLimit !== undefined && nextOperation >= operationLimit) return
      nextOperation += 1
      await measuredRequest(
        targetUrl,
        { method, headers },
        common.requestTimeoutMs,
        metrics,
        common.maxResponseBytes,
      )
    }
  }
}

async function runCrawlScenario(rawOptions) {
  const common = commonConfig(rawOptions)
  const baseUrl = validatedHttpUrl(stringOption(rawOptions, 'base-url', 'http://127.0.0.1:8080'), '--base-url')
  const healthUrl = resolveSameOriginPath(baseUrl, stringOption(rawOptions, 'health-path', '/actuator/health'), '--health-path')
  const crawlerHealthUrl = validatedHttpUrl(
    stringOption(rawOptions, 'crawler-health-url', 'http://127.0.0.1:8081/health/ready'),
    '--crawler-health-url',
  )
  const fixtureUrl = validatedHttpUrl(stringOption(rawOptions, 'fixture-url', 'http://127.0.0.1:9090/'), '--fixture-url')
  const fixtureHealthUrl = resolveSameOriginPath(fixtureUrl, '/__fixture/health', 'fixture health path')
  const pages = integerOption(rawOptions, 'pages', 100, { minimum: 1, maximum: 100_000 })
  const planOnly = flag(rawOptions, 'plan-only')
  const timeoutMs = durationOption(rawOptions, 'timeout', undefined, { minimum: 1_000, maximum: 24 * 60 * 60_000 })
  const pollIntervalMs = durationOption(rawOptions, 'poll-interval', '2s', { minimum: 100, maximum: 60_000 })
  const cancelOnTimeout = flag(rawOptions, 'no-cancel-on-timeout') ? false : true
  if (flag(rawOptions, 'cancel-on-timeout') && flag(rawOptions, 'no-cancel-on-timeout')) {
    throw new Error('Không được dùng đồng thời --cancel-on-timeout và --no-cancel-on-timeout.')
  }
  if (!planOnly && timeoutMs === undefined) throw new Error('Scenario crawl chạy thật bắt buộc có --timeout hữu hạn.')

  enforceTargetScope([baseUrl, healthUrl, crawlerHealthUrl, fixtureUrl, fixtureHealthUrl], common.scope)
  enforceHighLoadAcknowledgement({ pages, durationMs: timeoutMs }, flag(rawOptions, 'acknowledge-high-load'))

  const [controlPlanePreflight, crawlerPreflight, fixturePreflight] = await Promise.all([
    requireHealthy(healthUrl, common.requestTimeoutMs, 'Control Plane'),
    requireHealthy(crawlerHealthUrl, common.requestTimeoutMs, 'Crawler'),
    readFixturePreflight(fixtureHealthUrl, common.requestTimeoutMs),
  ])
  validateFixtureCapacity(fixturePreflight.config, pages)

  const baseReport = {
    schemaVersion: 1,
    scenario: 'crawl',
    startedAt: startedAt.toISOString(),
    generator: generatorProfile(),
    preflight: {
      controlPlane: controlPlanePreflight,
      crawler: crawlerPreflight,
      fixture: fixturePreflight.summary,
    },
    configuration: {
      controlPlane: sanitizedUrl(baseUrl),
      crawlerHealthEndpoint: sanitizedUrl(crawlerHealthUrl),
      fixture: sanitizedUrl(fixtureUrl),
      requestedPages: pages,
      requiredDepth: fixturePreflight.config.requiredDepth,
      timeoutMs: timeoutMs ?? null,
      pollIntervalMs,
      requestTimeoutMs: common.requestTimeoutMs,
      cancelOnTimeout,
    },
  }

  if (planOnly) {
    return {
      ...baseReport,
      outcome: 'PLANNED',
      finishedAt: new Date().toISOString(),
      plan: {
        mutatesState: false,
        requiredServerLimits: {
          maxPagesAtLeast: pages,
          maxDepthAtLeast: fixturePreflight.config.requiredDepth,
        },
        note: 'API hiện không có capability endpoint; giới hạn hiệu lực chỉ xác minh được sau khi tạo scan.',
      },
    }
  }

  const token = await requiredAuthentication(baseUrl, rawOptions, common.requestTimeoutMs)
  const authHeaders = { Accept: 'application/json', Authorization: `Bearer ${token}` }
  const metrics = new Metrics(common.requestTimeoutMs)
  const runStarted = performance.now()
  let scanId = null
  let websiteId = null
  let finalScan = null
  let timedOut = false

  websiteId = await resolveWebsite(baseUrl, fixtureUrl, rawOptions, authHeaders, common, metrics)
  const createUrl = resolveSameOriginPath(baseUrl, `/api/v1/websites/${encodeURIComponent(websiteId)}/scans`, 'scan endpoint')
  const created = await trackedJson(
    createUrl,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': crypto.randomUUID() },
    },
    common,
    metrics,
  )
  requireSuccess(created, 'Tạo scan')
  scanId = requireUuid(created.json?.id, 'scanId')
  finalScan = created.json

  const insufficient = validateEffectiveConfig(created.json?.effectiveConfig, pages, fixturePreflight.config.requiredDepth)
  if (insufficient.length > 0) {
    await cancelScan(baseUrl, scanId, authHeaders, common, metrics)
    throw new Error(`Scan đã được hủy vì cấu hình server chưa đủ: ${insufficient.join('; ')}.`)
  }

  const scanUrl = resolveSameOriginPath(baseUrl, `/api/v1/scans/${encodeURIComponent(scanId)}`, 'scan progress endpoint')
  const deadline = performance.now() + timeoutMs
  const terminal = new Set(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'])
  let nextProgressAt = 0

  while (!terminal.has(finalScan?.status)) {
    if (performance.now() >= deadline) {
      timedOut = true
      if (cancelOnTimeout) await cancelScan(baseUrl, scanId, authHeaders, common, metrics)
      break
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - performance.now())))
    const polled = await trackedJson(scanUrl, { method: 'GET', headers: authHeaders }, common, metrics)
    requireSuccess(polled, 'Đọc tiến độ scan')
    finalScan = polled.json
    if (performance.now() >= nextProgressAt) {
      const aggregate = metrics.snapshot(Math.ceil(performance.now() - runStarted))
      process.stdout.write(`${JSON.stringify({
        event: 'crawl_progress',
        scanId,
        status: finalScan?.status ?? 'UNKNOWN',
        progress: safeProgress(finalScan?.progress),
        requests: {
          completed: aggregate.completed,
          failed: aggregate.failed,
          p50Ms: aggregate.latencyMs.p50,
          p95Ms: aggregate.latencyMs.p95,
          p99Ms: aggregate.latencyMs.p99,
          statusHistogram: aggregate.statusHistogram,
          errorHistogram: aggregate.errorHistogram,
        },
      })}\n`)
      nextProgressAt = performance.now() + common.reportIntervalMs
    }
  }

  const elapsedMs = Math.ceil(performance.now() - runStarted)
  return {
    ...baseReport,
    outcome: timedOut ? 'FAILED' : terminalOutcome(finalScan?.status),
    finishedAt: new Date().toISOString(),
    elapsedMs,
    scan: {
      id: scanId,
      websiteId,
      status: finalScan?.status ?? 'UNKNOWN',
      progress: safeProgress(finalScan?.progress),
      effectiveConfig: safeEffectiveConfig(finalScan?.effectiveConfig),
      terminalReason: safeTerminalReason(finalScan?.terminalReason),
      runnerTimedOut: timedOut,
      cancellationRequestedOnTimeout: timedOut && cancelOnTimeout,
    },
    metrics: metrics.snapshot(elapsedMs),
  }
}

function commonConfig(rawOptions) {
  return {
    requestTimeoutMs: durationOption(rawOptions, 'request-timeout', '5s', { minimum: 100, maximum: 5 * 60_000 }),
    reportIntervalMs: durationOption(rawOptions, 'report-interval', '5s', { minimum: 250, maximum: 5 * 60_000 }),
    maxResponseBytes: integerOption(rawOptions, 'max-response-bytes', 1024 * 1024, {
      minimum: 1,
      maximum: 100 * 1024 * 1024,
    }),
    scope: {
      allowNonLoopback: flag(rawOptions, 'allow-non-loopback'),
      confirmTargetOwnership: flag(rawOptions, 'confirm-target-ownership'),
    },
  }
}

async function optionalAuthentication(baseUrl, rawOptions, timeoutMs) {
  const environmentToken = process.env.WEBLENS_LOAD_ACCESS_TOKEN?.trim()
  const email = stringOption(rawOptions, 'email', undefined)
  if (environmentToken && email) throw new Error('Chọn WEBLENS_LOAD_ACCESS_TOKEN hoặc --email, không dùng cả hai.')
  if (environmentToken) return environmentToken
  if (!email) return null
  return login(baseUrl, email, timeoutMs)
}

async function requiredAuthentication(baseUrl, rawOptions, timeoutMs) {
  const token = await optionalAuthentication(baseUrl, rawOptions, timeoutMs)
  if (!token) {
    throw new Error('Scenario crawl cần WEBLENS_LOAD_ACCESS_TOKEN hoặc --email cùng WEBLENS_LOAD_PASSWORD.')
  }
  return token
}

async function login(baseUrl, email, timeoutMs) {
  const password = process.env.WEBLENS_LOAD_PASSWORD
  if (!password) throw new Error('Thiếu biến môi trường WEBLENS_LOAD_PASSWORD.')
  const loginUrl = resolveSameOriginPath(baseUrl, '/api/v1/auth/sessions', 'login endpoint')
  const result = await jsonRequest(loginUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, timeoutMs)
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`Đăng nhập thất bại (HTTP ${result.response.status}).`)
  }
  const token = result.json?.accessToken
  if (typeof token !== 'string' || token.length === 0) throw new Error('Phản hồi đăng nhập thiếu access token.')
  return token
}

async function readFixturePreflight(url, timeoutMs) {
  const result = await jsonRequest(url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs)
  if (result.response.status < 200 || result.response.status >= 300 || result.json?.status !== 'UP') {
    throw new Error(`Fixture chưa sẵn sàng (HTTP ${result.response.status}).`)
  }
  return {
    config: result.json,
    summary: {
      status: result.response.status,
      latencyMs: result.latencyMs,
      pageCount: result.json.pageCount,
      fanout: result.json.fanout,
      requiredDepth: result.json.requiredDepth,
      delayMs: result.json.delayMs,
      bodyBytes: result.json.bodyBytes,
      robots: result.json.robots,
    },
  }
}

function validateFixtureCapacity(config, pages) {
  if (!Number.isSafeInteger(config?.pageCount) || config.pageCount < pages) {
    throw new Error(`Fixture phải cung cấp ít nhất ${pages} trang.`)
  }
  if (!Number.isSafeInteger(config?.requiredDepth) || config.requiredDepth < 0) {
    throw new Error('Fixture không trả về requiredDepth hợp lệ.')
  }
  if (config.robots !== 'allow') throw new Error('Fixture phải chạy với --robots allow để benchmark crawl.')
}

async function resolveWebsite(baseUrl, fixtureUrl, rawOptions, headers, common, metrics) {
  const explicitId = stringOption(rawOptions, 'website-id', undefined)
  const canonicalFixture = normalizedUrl(fixtureUrl)
  if (explicitId) {
    const websiteId = requireUuid(explicitId, 'websiteId')
    const websiteUrl = resolveSameOriginPath(
      baseUrl,
      `/api/v1/websites/${encodeURIComponent(websiteId)}`,
      'website detail endpoint',
    )
    const website = await trackedJson(websiteUrl, { method: 'GET', headers }, common, metrics)
    requireSuccess(website, 'Đọc website đã chọn')
    if (normalizedUrlString(website.json?.canonicalUrl) !== canonicalFixture) {
      throw new Error('Website đã chọn không trỏ chính xác tới fixture; scan chưa được tạo.')
    }
    return websiteId
  }

  let page = 0
  while (page < 1_000) {
    const listUrl = resolveSameOriginPath(
      baseUrl,
      `/api/v1/websites?page=${page}&size=100&status=ACTIVE&sort=updatedAt,desc`,
      'website list endpoint',
    )
    const listed = await trackedJson(listUrl, { method: 'GET', headers }, common, metrics)
    requireSuccess(listed, 'Liệt kê website')
    const match = listed.json?.items?.find((item) => normalizedUrlString(item?.canonicalUrl) === canonicalFixture)
    if (match) return requireUuid(match.id, 'websiteId')
    const totalPages = Number(listed.json?.totalPages ?? 0)
    page += 1
    if (!Number.isSafeInteger(totalPages) || page >= totalPages) break
  }

  const createUrl = resolveSameOriginPath(baseUrl, '/api/v1/websites', 'website create endpoint')
  const created = await trackedJson(createUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: stringOption(rawOptions, 'website-name', 'WebLens local load fixture'),
      url: fixtureUrl.toString(),
    }),
  }, common, metrics)
  requireSuccess(created, 'Đăng ký fixture website')
  return requireUuid(created.json?.id, 'websiteId')
}

async function cancelScan(baseUrl, scanId, headers, common, metrics) {
  const cancelUrl = resolveSameOriginPath(baseUrl, `/api/v1/scans/${encodeURIComponent(scanId)}/cancellations`, 'cancel endpoint')
  const result = await trackedJson(cancelUrl, { method: 'POST', headers }, common, metrics)
  if (result.response.status < 200 || result.response.status >= 300) {
    process.stderr.write(`${JSON.stringify({ event: 'crawl_cancel_failed', scanId, status: result.response.status })}\n`)
  }
}

async function trackedJson(url, init, common, metrics) {
  const requestStarted = performance.now()
  metrics.start()
  try {
    const result = await jsonRequest(url, init, common.requestTimeoutMs, { maxResponseBytes: common.maxResponseBytes })
    metrics.finish({ status: result.response.status, latencyMs: performance.now() - requestStarted, bytes: result.bytes })
    return result
  } catch (error) {
    metrics.finish({ error: classifyRequestError(error), latencyMs: performance.now() - requestStarted })
    throw error
  }
}

function requireSuccess(result, action) {
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`${action} thất bại (HTTP ${result.response.status}).`)
  }
}

function validateEffectiveConfig(config, requestedPages, requiredDepth) {
  const problems = []
  if (!Number.isSafeInteger(config?.maxPages) || config.maxPages < requestedPages) {
    problems.push(`maxPages=${String(config?.maxPages)} < ${requestedPages}`)
  }
  if (!Number.isSafeInteger(config?.maxDepth) || config.maxDepth < requiredDepth) {
    problems.push(`maxDepth=${String(config?.maxDepth)} < ${requiredDepth}`)
  }
  return problems
}

function startProgressTimer(metrics, runStarted, intervalMs, event) {
  const timer = setInterval(() => {
    const elapsedMs = Math.ceil(performance.now() - runStarted)
    const snapshot = metrics.snapshot(elapsedMs)
    process.stdout.write(`${JSON.stringify({
      event,
      elapsedMs,
      completed: snapshot.completed,
      inFlight: snapshot.inFlight,
      throughputRps: snapshot.throughputRps,
      p50Ms: snapshot.latencyMs.p50,
      p95Ms: snapshot.latencyMs.p95,
      p99Ms: snapshot.latencyMs.p99,
      failed: snapshot.failed,
      statusHistogram: snapshot.statusHistogram,
      errorHistogram: snapshot.errorHistogram,
    })}\n`)
  }, intervalMs)
  timer.unref?.()
  return timer
}

function terminalOutcome(status) {
  if (status === 'COMPLETED') return 'COMPLETED'
  if (status === 'PARTIAL_SUCCESS') return 'COMPLETED_WITH_ERRORS'
  return 'FAILED'
}

function safeProgress(progress) {
  if (!progress || typeof progress !== 'object') return null
  return Object.fromEntries(['discovered', 'queued', 'processed', 'succeeded', 'failed', 'limit']
    .filter((key) => Number.isFinite(progress[key]))
    .map((key) => [key, progress[key]]))
}

function safeEffectiveConfig(config) {
  if (!config || typeof config !== 'object') return null
  return Object.fromEntries([
    'maxPages',
    'maxDepth',
    'maxResponseBytes',
    'maxDurationSeconds',
    'maxRedirects',
    'concurrency',
  ].filter((key) => Number.isFinite(config[key])).map((key) => [key, config[key]]))
}

function safeTerminalReason(reason) {
  if (!reason || typeof reason !== 'object') return null
  return { code: typeof reason.code === 'string' ? reason.code : 'UNKNOWN' }
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} không phải UUID hợp lệ.`)
  }
  return value
}

function normalizedUrl(url) {
  const copy = new URL(url)
  copy.hash = ''
  if (!copy.pathname) copy.pathname = '/'
  return copy.toString()
}

function normalizedUrlString(raw) {
  if (typeof raw !== 'string') return null
  try {
    return normalizedUrl(validatedHttpUrl(raw, 'canonical URL'))
  } catch {
    return null
  }
}

function safeFailure(error) {
  if (error instanceof RequestFailure) return { category: error.category, status: error.status ?? null }
  return {
    category: 'CONFIGURATION_OR_RUNTIME_ERROR',
    message: typeof error?.message === 'string' ? error.message : 'Unknown failure',
  }
}

function generatorProfile() {
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
