import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Request, type Response } from 'playwright'
import { assertPublicHttpUrl } from './security.js'
import { SafeProxy } from './safe-proxy.js'
import type {
  CaptureCommandPayload,
  CaptureResult,
  DiffSummary,
  Measurement,
  NetworkRecord,
  RenderedMetadata,
  ResourceBody,
} from './types.js'

interface BrowserMetricState {
  lcp: number | null
  cls: number
  lcpObserved: boolean
  clsObserved: boolean
}

interface ResponseCandidate {
  response: Response
  sequence: number
  url: string
  resourceType: string
  mimeType: string
}

const bodyResourceTypes = new Set(['stylesheet', 'script', 'image', 'font'])

export async function capturePage(command: CaptureCommandPayload): Promise<CaptureResult> {
  await assertPublicHttpUrl(command.targetUrl)
  const proxy = new SafeProxy()
  await proxy.start()
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  try {
    browser = await chromium.launch({ headless: true, proxy: { server: proxy.url() } })
    context = await browser.newContext({
    viewport: { width: command.viewportWidth, height: command.viewportHeight },
    deviceScaleFactor: 1,
    acceptDownloads: false,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
  })
    const page = await context.newPage()
  const started = Date.now()
  const requestStarted = new Map<Request, { started: number; sequence: number }>()
  const network: NetworkRecord[] = []
  const candidates: ResponseCandidate[] = []
  let sequence = 0
  let totalTransferBytes = 0

  await page.addInitScript(() => {
    const state: BrowserMetricState = { lcp: null, cls: 0, lcpObserved: false, clsObserved: false }
    ;(window as unknown as { __weblensMetrics: BrowserMetricState }).__weblensMetrics = state
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries.at(-1)
        if (last) {
          state.lcp = last.startTime
          state.lcpObserved = true
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    } catch {
      // Browser capability is reported as UNAVAILABLE after capture.
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
          if (!shift.hadRecentInput && typeof shift.value === 'number') state.cls += shift.value
          state.clsObserved = true
        }
      }).observe({ type: 'layout-shift', buffered: true })
    } catch {
      // Browser capability is reported as UNAVAILABLE after capture.
    }
  })

  await page.route('**/*', async (route) => {
    try {
      const target = route.request().url()
      if (!target.startsWith('data:') && !target.startsWith('blob:')) await assertPublicHttpUrl(target)
      await route.continue()
    } catch {
      await route.abort('blockedbyclient')
    }
  })

  page.on('request', (request) => {
    if (requestStarted.size >= command.maxNetworkRequests) return
    requestStarted.set(request, { started: Date.now(), sequence: sequence++ })
  })
  page.on('response', (response) => {
    const request = response.request()
    const tracked = requestStarted.get(request)
    if (!tracked || network.length >= command.maxNetworkRequests) return
    const headers = response.headers()
    const contentLength = boundedNumber(headers['content-length'])
    totalTransferBytes += contentLength
    const mimeType = capText((headers['content-type'] ?? '').split(';')[0] ?? '', 255)
    const resourceType = capText(request.resourceType(), 32)
    network.push({
      requestId: randomUUID(),
      sequence: tracked.sequence,
      url: sanitizeUrl(response.url()),
      method: capText(request.method(), 16),
      resourceType,
      statusCode: response.status(),
      mimeType,
      responseBytes: contentLength,
      durationMs: Math.max(0, Date.now() - tracked.started),
      failureCode: '',
    })
    if (bodyResourceTypes.has(resourceType) && candidates.length < command.maxResourceBodies) {
      candidates.push({ response, sequence: tracked.sequence, url: sanitizeUrl(response.url()), resourceType, mimeType })
    }
  })
  page.on('requestfailed', (request) => {
    const tracked = requestStarted.get(request)
    if (!tracked || network.some((record) => record.sequence === tracked.sequence)
      || network.length >= command.maxNetworkRequests) return
    network.push({
      requestId: randomUUID(), sequence: tracked.sequence, url: sanitizeUrl(request.url()),
      method: capText(request.method(), 16), resourceType: capText(request.resourceType(), 32),
      statusCode: 0, mimeType: '', responseBytes: 0,
      durationMs: Math.max(0, Date.now() - tracked.started),
      failureCode: capText(request.failure()?.errorText ?? 'REQUEST_FAILED', 64),
    })
  })

    await page.goto(command.targetUrl, { waitUntil: 'load', timeout: command.timeoutSeconds * 1000 })
    const remaining = command.timeoutSeconds * 1000 - (Date.now() - started)
    if (remaining > 0) await page.waitForTimeout(Math.min(5000, remaining))
    if (Date.now() - started > command.timeoutSeconds * 1000) throw new Error('CAPTURE_TIMEOUT')

    const observedAt = new Date().toISOString()
    const rendered = await extractRenderedMetadata(page)
    const browserMetrics = await page.evaluate(() => {
      return (window as unknown as { __weblensMetrics?: BrowserMetricState }).__weblensMetrics
        ?? { lcp: null, cls: 0, lcpObserved: false, clsObserved: false }
    })
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      return entry ? { requestStart: entry.requestStart, responseStart: entry.responseStart } : null
    })
    const measuredPerformance = performanceSummary(command.measurementProfile, browserMetrics, navigation)
    const html = Buffer.from(await page.content(), 'utf8')
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false })
    if (html.length + screenshot.length > command.maxTotalBytes) throw new Error('CAPTURE_BYTE_BUDGET_EXCEEDED')
    const resourceBodies = await collectResourceBodies(
      candidates,
      command.maxResourceBytes,
      command.maxTotalBytes - html.length - screenshot.length,
    )
    const bodyBytes = resourceBodies.reduce((total, resource) => total + resource.body.length, 0)
    if (totalTransferBytes > command.maxTotalBytes) throw new Error('CAPTURE_TRANSFER_BUDGET_EXCEEDED')
    const finalUrl = (await assertPublicHttpUrl(page.url())).toString()
    return {
      finalUrl,
      html,
      screenshot: Buffer.from(screenshot),
      rendered,
      diff: diff(command.staticObservation, rendered, observedAt),
      performance: measuredPerformance,
      network: network.sort((left, right) => left.sequence - right.sequence),
      resourceBodies,
      browserVersion: capText(browser.version(), 64),
      observedAt,
      totalTransferBytes: Math.min(totalTransferBytes + bodyBytes, command.maxTotalBytes),
    }
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await proxy.close().catch(() => undefined)
  }
}

async function extractRenderedMetadata(page: import('playwright').Page): Promise<RenderedMetadata> {
  return page.evaluate(() => {
    const cap = (value: string | null | undefined, bytes: number): string => {
      const encoded = new TextEncoder().encode((value ?? '').trim())
      return new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, bytes)).replace(/\uFFFD$/u, '')
    }
    const meta = (selector: string, bytes: number) => cap(document.querySelector<HTMLMetaElement>(selector)?.content, bytes)
    const link = (selector: string) => {
      const href = document.querySelector<HTMLLinkElement>(selector)?.href
      return cap(href, 8192)
    }
    const schemaTypes: string[] = []
    const seen = new Set<string>()
    const addType = (candidate: unknown) => {
      if (typeof candidate !== 'string' || schemaTypes.length >= 100) return
      const value = cap(candidate.split(/[\/#]/u).filter(Boolean).at(-1), 255)
      const key = value.toLowerCase()
      if (value && !seen.has(key)) {
        seen.add(key)
        schemaTypes.push(value)
      }
    }
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit)
      } else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>
        const type = object['@type']
        if (Array.isArray(type)) type.forEach(addType)
        else addType(type)
        Object.entries(object).forEach(([key, child]) => { if (key !== '@type') visit(child) })
      }
    }
    let jsonBytes = 0
    const blocks = [...document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')].slice(0, 20)
    for (const block of blocks) {
      const raw = block.textContent ?? ''
      jsonBytes += new TextEncoder().encode(raw).length
      if (jsonBytes > 1_048_576) break
      try { visit(JSON.parse(raw) as unknown) } catch { /* Summary excludes raw invalid input. */ }
    }
    document.querySelectorAll<HTMLElement>('[itemscope][itemtype]').forEach((element) => {
      element.getAttribute('itemtype')?.split(/\s+/u).forEach(addType)
    })
    const text = document.body?.innerText ?? ''
    return {
      title: cap(document.title, 2048),
      description: meta('meta[name="description" i]', 4096),
      canonicalUrl: link('link[rel~="canonical" i]'),
      metaRobots: meta('meta[name="robots" i]', 512),
      h1: [...document.querySelectorAll('h1')].slice(0, 50).map((heading) => cap(heading.textContent, 2048)).filter(Boolean),
      wordCount: (text.match(/[\p{L}\p{N}]+/gu) ?? []).length,
      linkCount: document.querySelectorAll('a[href],area[href]').length,
      imageCount: document.images.length,
      openGraph: {
        title: meta('meta[property="og:title" i]', 2048),
        description: meta('meta[property="og:description" i]', 4096),
        imageUrl: meta('meta[property="og:image" i]', 8192),
      },
      schemaOrgTypes: schemaTypes,
    }
  })
}

function performanceSummary(
  profile: string,
  metrics: BrowserMetricState,
  navigation: { requestStart: number; responseStart: number } | null,
): { lcp: Measurement; cls: Measurement; ttfb: Measurement } {
  const measurement = (value: number | null, unit: 'ms' | 'score', reason: string | null): Measurement => ({
    status: value === null ? 'UNAVAILABLE' : 'AVAILABLE',
    value,
    unit,
    source: 'PLAYWRIGHT_LAB',
    profileVersion: profile,
    unavailableReason: value === null ? reason : null,
  })
  const ttfb = navigation && navigation.responseStart >= navigation.requestStart
    ? navigation.responseStart - navigation.requestStart
    : null
  return {
    lcp: measurement(metrics.lcpObserved ? metrics.lcp : null, 'ms', 'NO_LCP_ENTRY'),
    cls: measurement(metrics.clsObserved ? metrics.cls : null, 'score', 'NO_LAYOUT_SHIFT_ENTRY'),
    ttfb: measurement(ttfb, 'ms', 'NO_NAVIGATION_TIMING'),
  }
}

async function collectResourceBodies(
  candidates: ResponseCandidate[],
  maxResourceBytes: number,
  remainingBudget: number,
): Promise<ResourceBody[]> {
  const bodies: ResourceBody[] = []
  let remaining = Math.max(0, remainingBudget)
  for (const candidate of candidates) {
    if (remaining <= 0) break
    try {
      await candidate.response.finished()
      const raw = Buffer.from(await candidate.response.body())
      if (raw.length === 0) continue
      const allowed = Math.min(maxResourceBytes, remaining)
      const body = raw.subarray(0, allowed)
      bodies.push({
        resourceId: randomUUID(), sequence: candidate.sequence, url: candidate.url,
        resourceType: candidate.resourceType, mimeType: candidate.mimeType,
        body, wasTruncated: raw.length > body.length,
      })
      remaining -= body.length
    } catch {
      // Resource bodies are optional evidence; network metadata remains authoritative.
    }
  }
  return bodies
}

function diff(staticValue: CaptureCommandPayload['staticObservation'], rendered: RenderedMetadata, at: string): DiffSummary {
  const normalizedTypes = (values: string[]) => [...values].map((value) => value.toLowerCase()).sort().join('\n')
  const renderedH1 = rendered.h1[0] ?? null
  const titleChanged = (staticValue.title ?? '') !== rendered.title
  const descriptionChanged = (staticValue.description ?? '') !== rendered.description
  const canonicalChanged = (staticValue.canonicalUrl ?? '') !== rendered.canonicalUrl
  const h1Changed = (staticValue.h1 ?? '') !== (renderedH1 ?? '')
  const linkCountDelta = rendered.linkCount - staticValue.links
  const imageCountDelta = rendered.imageCount - staticValue.images
  return {
    staticObservedAt: staticValue.observedAt,
    renderedObservedAt: at,
    titleChanged,
    descriptionChanged,
    canonicalChanged,
    h1Changed,
    contentChanged: titleChanged || descriptionChanged || h1Changed || linkCountDelta !== 0 || imageCountDelta !== 0,
    linkCountDelta,
    imageCountDelta,
    schemaTypesChanged: normalizedTypes(staticValue.schemaOrgTypes) !== normalizedTypes(rendered.schemaOrgTypes),
  }
}

function capText(value: string | null | undefined, bytes: number): string {
  const encoded = Buffer.from((value ?? '').trim(), 'utf8')
  if (encoded.length <= bytes) return encoded.toString('utf8')
  return encoded.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function boundedNumber(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 52_428_800) : 0
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|auth|key|secret|signature|credential|password)/i.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    return capText(parsed.toString(), 8192)
  } catch {
    return ''
  }
}
