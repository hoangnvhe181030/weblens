#!/usr/bin/env node

import http from 'node:http'
import {
  assertKnownOptions,
  durationOption,
  flag,
  integerOption,
  parseCommandLine,
  stringOption,
} from './lib/cli.mjs'
import { enforceHighLoadAcknowledgement, isLoopbackHostname } from './lib/safety.mjs'

const HELP = `
HTTP crawl fixture xác định, sinh trang theo yêu cầu mà không giữ toàn bộ site trong RAM.

Cách dùng:
  node tools/load/fixture.mjs [tùy chọn]

Tùy chọn:
  --host <host>             Địa chỉ bind loopback (mặc định 127.0.0.1)
  --port <port>             Cổng HTTP (mặc định 9090)
  --pages <n>               Tổng số trang, tối đa 100000 (mặc định 100)
  --fanout <n>              Số link con mỗi trang (mặc định 32)
  --delay <duration>        Độ trễ mỗi trang, ví dụ 10ms (mặc định 0ms)
  --body-bytes <n>          Kích thước chính xác mỗi HTML response (mặc định 4096)
  --robots <allow|deny>     Chính sách robots.txt (mặc định allow)
  --acknowledge-high-load   Xác nhận cấu hình lớn có thể làm máy local quá tải
  --help                    Hiện trợ giúp
`

const ALLOWED_OPTIONS = new Set([
  'host',
  'port',
  'pages',
  'fanout',
  'delay',
  'body-bytes',
  'robots',
  'acknowledge-high-load',
  'help',
])

const { options } = parseCommandLine(['fixture', ...process.argv.slice(2)])
assertKnownOptions(options, ALLOWED_OPTIONS)
if (flag(options, 'help')) {
  process.stdout.write(HELP)
  process.exit(0)
}

const config = {
  host: stringOption(options, 'host', '127.0.0.1'),
  port: integerOption(options, 'port', 9090, { minimum: 0, maximum: 65_535 }),
  pageCount: integerOption(options, 'pages', 100, { minimum: 1, maximum: 100_000 }),
  fanout: integerOption(options, 'fanout', 32, { minimum: 1, maximum: 10_000 }),
  delayMs: durationOption(options, 'delay', '0ms', { minimum: 0, maximum: 60_000 }),
  bodyBytes: integerOption(options, 'body-bytes', 4096, { minimum: 256, maximum: 100 * 1024 * 1024 }),
  robots: stringOption(options, 'robots', 'allow'),
}

if (!isLoopbackHostname(config.host)) {
  throw new Error('--host chỉ được bind vào loopback (127.0.0.0/8, ::1 hoặc localhost).')
}
if (!['allow', 'deny'].includes(config.robots)) throw new Error('--robots chỉ nhận allow hoặc deny.')
enforceHighLoadAcknowledgement({
  pages: config.pageCount,
  fanout: config.fanout,
  bodyBytes: config.bodyBytes,
}, flag(options, 'acknowledge-high-load'))

const maximumMarkupBytes = calculateMaximumMarkupBytes(config)
if (config.bodyBytes < maximumMarkupBytes) {
  throw new Error(`--body-bytes quá nhỏ cho fanout đã chọn; cần ít nhất ${maximumMarkupBytes} bytes.`)
}

const paddingChunk = Buffer.alloc(Math.min(64 * 1024, config.bodyBytes), 0x78)
const requiredDepth = calculateRequiredDepth(config.pageCount, config.fanout)
const server = http.createServer((request, response) => {
  void route(request, response).catch(() => {
    if (!response.headersSent) writeText(response, 500, 'fixture_error\n', 'text/plain; charset=utf-8')
    else response.destroy()
  })
})

server.keepAliveTimeout = 5_000
server.headersTimeout = 10_000
server.requestTimeout = 10_000

server.listen(config.port, config.host, () => {
  const printableHost = config.host.includes(':') ? `[${config.host}]` : config.host
  const address = server.address()
  const listeningPort = typeof address === 'object' && address ? address.port : config.port
  process.stdout.write(`${JSON.stringify({
    event: 'fixture_ready',
    url: `http://${printableHost}:${listeningPort}/`,
    pageCount: config.pageCount,
    fanout: config.fanout,
    requiredDepth,
    delayMs: config.delayMs,
    bodyBytes: config.bodyBytes,
    robots: config.robots,
  })}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.closeIdleConnections?.()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  })
}

async function route(request, response) {
  response.sendDate = false
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://fixture.invalid')

  if (url.pathname === '/__fixture/health' && (method === 'GET' || method === 'HEAD')) {
    writeJson(response, 200, {
      status: 'UP',
      pageCount: config.pageCount,
      fanout: config.fanout,
      requiredDepth,
      delayMs: config.delayMs,
      bodyBytes: config.bodyBytes,
      robots: config.robots,
    }, method === 'HEAD')
    return
  }

  if (url.pathname === '/robots.txt' && (method === 'GET' || method === 'HEAD')) {
    const rule = config.robots === 'allow' ? 'Allow: /' : 'Disallow: /'
    writeText(response, 200, `User-agent: *\n${rule}\n`, 'text/plain; charset=utf-8', method === 'HEAD')
    return
  }

  if (url.pathname === '/favicon.ico') {
    writeText(response, 404, 'not_found\n', 'text/plain; charset=utf-8', method === 'HEAD')
    return
  }

  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    writeText(response, 405, 'method_not_allowed\n', 'text/plain; charset=utf-8', method === 'HEAD')
    return
  }

  const pageId = parsePageId(url.pathname)
  if (pageId === null || pageId >= config.pageCount) {
    writeText(response, 404, 'not_found\n', 'text/plain; charset=utf-8', method === 'HEAD')
    return
  }

  if (config.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.delayMs))
  await writePage(response, pageId, method === 'HEAD')
}

function parsePageId(pathname) {
  if (pathname === '/') return 0
  const match = /^\/page\/([1-9]\d*)$/.exec(pathname)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : null
}

async function writePage(response, pageId, headOnly) {
  const [prefix, suffix] = pageMarkup(config, pageId)
  const markupBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
  const paddingBytes = config.bodyBytes - markupBytes

  response.statusCode = 200
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Content-Length', String(config.bodyBytes))
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('ETag', `"weblens-fixture-${pageId}-${config.bodyBytes}"`)
  if (headOnly) {
    response.end()
    return
  }

  if (!response.write(prefix) && !await waitForDrain(response, 5_000)) return
  let remaining = paddingBytes
  while (remaining > 0 && !response.destroyed) {
    const length = Math.min(remaining, paddingChunk.length)
    if (!response.write(paddingChunk.subarray(0, length)) && !await waitForDrain(response, 5_000)) return
    remaining -= length
  }
  if (!response.destroyed && !response.writableEnded) response.end(suffix)
}

function waitForDrain(response, timeoutMs) {
  if (response.destroyed || response.writableEnded || response.closed) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)

    function onDrain() { finish(true) }
    function onClose() { finish(false) }
    function onError() { finish(false) }
    function finish(writable) {
      clearTimeout(timeout)
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
      if (!writable && !response.destroyed) response.destroy()
      resolve(writable)
    }
  })
}

function pageMarkup({ pageCount, fanout }, pageId) {
  const firstChild = pageId * fanout + 1
  const links = []
  for (let child = firstChild; child < firstChild + fanout && child < pageCount; child += 1) {
    links.push(`<a href="/page/${child}">page-${child}</a>`)
  }
  const canonical = pageId === 0 ? '/' : `/page/${pageId}`
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture page ${pageId}</title><link rel="canonical" href="${canonical}"></head><body><main><h1>Fixture page ${pageId}</h1><nav>${links.join('')}</nav><p>`,
    '</p></main></body></html>',
  ]
}

function calculateMaximumMarkupBytes({ pageCount, fanout }) {
  const candidates = new Set([0, pageCount - 1])
  const lastFullParent = Math.floor((pageCount - 1 - fanout) / fanout)
  if (lastFullParent >= 0) candidates.add(lastFullParent)
  const lastParent = Math.floor((pageCount - 2) / fanout)
  if (lastParent >= 0) candidates.add(lastParent)
  return Math.max(...[...candidates].map((pageId) => {
    const [prefix, suffix] = pageMarkup({ pageCount, fanout }, pageId)
    return Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
  }))
}

function calculateRequiredDepth(pageCount, fanout) {
  let pageId = pageCount - 1
  let depth = 0
  while (pageId > 0) {
    pageId = Math.floor((pageId - 1) / fanout)
    depth += 1
  }
  return depth
}

function writeJson(response, status, value, headOnly = false) {
  writeText(response, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8', headOnly)
}

function writeText(response, status, body, contentType, headOnly = false) {
  const bytes = Buffer.byteLength(body)
  response.statusCode = status
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', String(bytes))
  response.setHeader('Cache-Control', 'no-store')
  response.end(headOnly ? undefined : body)
}
