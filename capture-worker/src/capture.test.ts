import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import {
  capturePage,
  collectResourceBodies,
  isSafeExpansionLabel,
  sanitizeUrl,
  waitForDesignStability,
  type ResponseCandidate,
} from './capture.js'

test('capture rejects an aborted lease before starting browser work', async () => {
  const controller = new AbortController()
  const error = new Error('STALE_CAPTURE_LEASE')
  controller.abort(error)
  await assert.rejects(capturePage({} as Parameters<typeof capturePage>[0], {
    signal: controller.signal,
  }), (actual: unknown) => actual === error)
})

test('Design Clone waits for DOM and requests to settle, with a bounded wait', {
  skip: process.env.WEBLENS_BROWSER_SMOKE !== 'true', timeout: 20_000,
}, async (t) => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<main>Ready</main>')
    await t.test('stable pages return before the old five-second delay', async () => {
      const start = Date.now()
      await waitForDesignStability(page, { pending: 0, lastActivity: 0 }, start + 4_000)
      assert.ok(Date.now() - start < 2_500)
    })
    await t.test('late DOM updates restart the quiet period', async () => {
      await page.evaluate(() => {
        setTimeout(() => { document.querySelector('main')!.textContent = 'Loading' }, 200)
        setTimeout(() => { document.querySelector('main')!.textContent = 'Loaded' }, 600)
      })
      const start = Date.now()
      await waitForDesignStability(page, { pending: 0, lastActivity: 0 }, start + 4_000)
      assert.equal(await page.locator('main').textContent(), 'Loaded')
      assert.ok(Date.now() - start >= 1_000)
    })
    await t.test('pending requests prevent early completion', async () => {
      const network = { pending: 1, lastActivity: 0 }
      const timer = setTimeout(() => { network.pending = 0; network.lastActivity = Date.now() }, 800)
      const start = Date.now()
      try {
        await waitForDesignStability(page, network, start + 4_000)
        assert.ok(Date.now() - start >= 1_250)
      } finally { clearTimeout(timer) }
    })
    await t.test('busy pages stop at the deadline and release the observer', async () => {
      const interval = await page.evaluate(() => setInterval(() => {
        document.querySelector('main')!.textContent = String(performance.now())
      }, 50))
      const start = Date.now()
      try {
        await waitForDesignStability(page, { pending: 1, lastActivity: 0 }, start + 800)
        assert.ok(Date.now() - start < 2_500)
        assert.equal(await page.evaluate(() => '__weblensDesignStability' in window), false)
      } finally { await page.evaluate((id) => clearInterval(id), interval) }
    })
    await t.test('capture produces a rendered bundle without a screenshot or page ZIP', async () => {
      const requestedImages = new Set<string>()
      const fixture = createServer((request, response) => {
        if (request.url?.endsWith('/pending.png')) return
        if (request.url?.endsWith('.png')) {
          requestedImages.add(request.url)
          response.writeHead(200, { 'Content-Type': 'image/png' })
          response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<title>Fixture</title>'
          + '<link rel="preload" as="image" href="/large.png" imagesrcset="/small.png 320w, /large.png 1365w" imagesizes="100vw">'
          + '<main>Ready</main><input value="private-fixture-value">'
          + '<picture><source srcset="/small.png 320w, /large.png 1365w">'
          + '<img src="/small.png" srcset="/small.png 320w, /large.png 1365w" sizes="100vw"></picture>'
          + '<div style="width:100px;overflow:hidden"><img loading="lazy" src="/horizontal.png" style="margin-left:20000px"></div>'
          + '<section id="middle" style="margin-top:1600px;opacity:0">Lazy content</section><div style="height:2500px"></div>'
          + '<button disabled>ordinary control</button>'.repeat(95)
          + '<script>const style = document.createElement("style"); document.head.append(style);'
          + 'style.sheet.insertRule(".cssom-rule{color:rgb(1,2,3)}");'
          + 'const disabled = document.createElement("style"); document.head.append(disabled);'
          + 'disabled.sheet.insertRule("body{display:none}"); disabled.sheet.disabled = true;'
          + 'const middle = document.querySelector("#middle");'
          + 'new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting)'
          + 'entry.target.setAttribute("data-visited", "true"); }).observe(middle);'
          + 'if (matchMedia("(prefers-reduced-motion: reduce)").matches) {'
          + 'middle.setAttribute("data-revealed", "true"); middle.style.opacity = "1";'
          + '} else new IntersectionObserver(entries => { for (const entry of entries) {'
          + 'if (entry.isIntersecting) entry.target.setAttribute("data-revealed", "true");'
          + 'else entry.target.removeAttribute("data-revealed"); }}).observe(middle);'
          + 'setTimeout(() => { document.querySelector("main").textContent = "Loaded";'
          + 'const pending = new Image(); pending.src = "/pending.png"; document.body.append(pending); }, 300)</script>')
      })
      await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
      const address = fixture.address()
      assert.ok(address && typeof address !== 'string')
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
        proxy: { server: `http://127.0.0.1:${address.port}` } })
      try {
        // tsx names nested functions with this helper when serializing browser callbacks.
        await context.addInitScript('globalThis.__name ??= (value) => value')
        const result = await capturePage({
          captureRequestId: 'fixture', ownerId: 'owner', scanId: 'scan', pageId: 'page',
          targetUrl: 'http://example.com/', viewportWidth: 1365, viewportHeight: 768,
          timeoutSeconds: 30, maxTotalBytes: 52_428_800, maxResourceBytes: 10_485_760,
          maxNetworkRequests: 500, maxResourceBodies: 100, measurementProfile: 'desktop-lab-v1',
          staticObservation: { title: null, description: null, canonicalUrl: null, h1: null,
            links: 0, images: 0, schemaOrgTypes: [], observedAt: null },
        }, { browserContext: context, includeSiteBundle: true, captureScreenshot: false,
          contentAddressedResources: true, mainPath: 'index.html' })
        assert.equal(result.screenshot.length, 0)
        assert.equal(result.reconstruction.archivePath, null)
        assert.equal(result.reconstruction.temporaryDirectory, null)
        const html = result.reconstruction.siteBundle!.files[0]!.body.toString()
        assert.match(html, /<main>Loaded<\/main>/u)
        assert.match(html, /<style>\.cssom-rule\s*\{\s*color: rgb\(1, 2, 3\);\s*\}<\/style>/u)
        assert.match(html, /<style media="not all">body\s*\{\s*display: none;\s*\}<\/style>/u)
        assert.doesNotMatch(html, /small\.png/u)
        assert.match(html, /<img[^>]+src="assets\/[a-f0-9]+\.png"/u)
        assert.match(html, /imagesrcset="assets\/[a-f0-9]+\.png 1365w"/u)
        assert.match(html, /id="middle"[^>]+data-revealed="true"/u)
        assert.match(html, /id="middle"[^>]+data-visited="true"/u)
        assert.equal([...requestedImages].some(url => url.endsWith('/horizontal.png')), true)
        assert.doesNotMatch(html, /horizontal\.png/u)
        assert.match(html, /loading="eager"/u)
        assert.ok(result.reconstruction.siteBundle!.resourceGaps?.some(resource =>
          resource.sourceUrl.endsWith('/pending.png') && resource.reason === 'RESOURCE_TIMEOUT'))
        assert.doesNotMatch(html, /private-fixture-value/u)
      } finally {
        await context.close()
        fixture.closeAllConnections()
        await new Promise<void>((resolve) => fixture.close(() => resolve()))
      }
    })
  } finally { await browser.close() }
})

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

test('chỉ tự động bấm điều khiển mở rộng rõ ràng và không phá hoại', () => {
  assert.equal(isSafeExpansionLabel('Xem thêm bài viết'), true)
  assert.equal(isSafeExpansionLabel('Load more'), true)
  assert.equal(isSafeExpansionLabel('Xóa và xem thêm'), false)
  assert.equal(isSafeExpansionLabel('Đăng xuất'), false)
  assert.equal(isSafeExpansionLabel('Gửi biểu mẫu'), false)
})

test('bỏ resource đã lỗi trước khi đọc body và không gọi Playwright wait', async () => {
  let finishedCalls = 0
  const value = candidate({
    skipReason: 'HTTP_FAILURE',
    finished: async () => { finishedCalls += 1; return null },
  })

  const result = await collectResourceBodies([value], 1_024, 1_024, Date.now() + 100)

  assert.equal(finishedCalls, 0)
  assert.equal(result.bodies.length, 0)
  assert.equal(result.cloneInputs[0]?.skipReason, 'HTTP_FAILURE')
})

test('requestfailed sau response giải phóng wait đang treo', async () => {
  const value = candidate({ finished: () => new Promise(() => undefined) })
  setTimeout(() => {
    value.skipReason = 'REQUEST_FAILED'
    value.markFailed()
  }, 5)

  const result = await collectResourceBodies([value], 1_024, 1_024, Date.now() + 200)

  assert.equal(result.bodies.length, 0)
  assert.equal(result.cloneInputs[0]?.skipReason, 'REQUEST_FAILED')
})

test('body không kết thúc bị giới hạn thời gian và candidate đến muộn không được nhập giữa vòng lặp', async () => {
  const candidates: ResponseCandidate[] = []
  const late = candidate()
  const first = candidate({
    finished: async () => {
      candidates.push(late)
      return null
    },
    body: () => new Promise(() => undefined),
  })
  candidates.push(first)

  const started = Date.now()
  const result = await collectResourceBodies(candidates, 1_024, 1_024, Date.now() + 30)

  assert.ok(Date.now() - started < 1_000)
  assert.equal(result.cloneInputs.length, 1)
  assert.equal(result.cloneInputs[0]?.skipReason, 'RESOURCE_TIMEOUT')
})

test('truncated body releases the oversized backing buffer', async () => {
  const source = Buffer.alloc(8 * 1024 * 1024, 1)
  const result = await collectResourceBodies([candidate({ body: async () => source })], 1024, 1024, Date.now() + 1000)
  const body = result.bodies[0]!.body
  assert.equal(body.length, 1024)
  assert.ok(body.buffer.byteLength <= 8192)
  assert.notEqual(body.buffer, source.buffer)
  assert.equal(result.bodies[0]!.wasTruncated, true)
})

function candidate(overrides: {
  skipReason?: string | null
  finished?: () => Promise<Error | null>
  body?: () => Promise<Buffer>
} = {}): ResponseCandidate {
  let markFailed: () => void = () => undefined
  const failed = new Promise<void>((resolveFailure) => { markFailed = resolveFailure })
  return {
    response: {
      finished: overrides.finished ?? (async () => null),
      body: overrides.body ?? (async () => Buffer.from('body')),
    },
    sequence: 1,
    sourceUrl: 'https://example.com/image.webp',
    publicUrl: 'https://example.com/image.webp',
    resourceType: 'image',
    mimeType: 'image/webp',
    captureBody: true,
    skipReason: overrides.skipReason ?? null,
    failed,
    markFailed,
  }
}
