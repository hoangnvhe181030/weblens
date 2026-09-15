import type { Capture, PageSnapshot, Scan, ScanPageRecord, ScanPagesReport, Website } from '../domain/types'
import type { WebLensService } from '../services/mockWebLensService'
import { apiBlobRequest, apiRequest } from './apiClient'
import type { ApiCapture, ApiCaptureSnapshot, ApiPage, ApiScan, ApiScanPage, ApiScanPages, ApiWebsite } from './contracts'

export const backendWebLensService: WebLensService = {
  async listWebsites() {
    const page = await apiRequest<ApiPage<ApiWebsite>>('/api/v1/websites?page=0&size=100&status=ACTIVE&sort=updatedAt,desc')
    return page.items.map(mapWebsite)
  },

  async getWebsite(id) {
    return mapWebsite(await apiRequest<ApiWebsite>(`/api/v1/websites/${encodeURIComponent(id)}`))
  },

  async createWebsite(name, url) {
    return mapWebsite(await apiRequest<ApiWebsite>('/api/v1/websites', {
      method: 'POST',
      body: JSON.stringify({ name, url }),
    }))
  },

  async listScans(websiteId) {
    const page = await apiRequest<ApiPage<ApiScan>>(`/api/v1/websites/${encodeURIComponent(websiteId)}/scans?page=0&size=100`)
    return page.items.map(mapScan)
  },

  async getScan(id) {
    return mapScan(await apiRequest<ApiScan>(`/api/v1/scans/${encodeURIComponent(id)}`))
  },

  async startScan(websiteId, idempotencyKey) {
    return mapScan(await apiRequest<ApiScan>(`/api/v1/websites/${encodeURIComponent(websiteId)}/scans`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    }))
  },

  async cancelScan(id) {
    return mapScan(await apiRequest<ApiScan>(`/api/v1/scans/${encodeURIComponent(id)}/cancellations`, {
      method: 'POST',
    }))
  },

  async listScanPages(scanId, cursor): Promise<ScanPagesReport> {
		const query = new URLSearchParams({ limit: '200' })
		if (cursor) query.set('cursor', cursor)
		const response = await apiRequest<ApiScanPages>(`/api/v1/scans/${encodeURIComponent(scanId)}/pages?${query}`)
    return {
      items: response.items.map(mapScanPage),
      analyticsExpectedCount: response.analyticsExpectedCount,
      analyticsPublishedCount: response.analyticsPublishedCount,
      analyticsWatermark: response.analyticsWatermark ? formatInstant(response.analyticsWatermark) : null,
      fresh: response.fresh,
			nextCursor: response.nextCursor ?? undefined,
    }
  },

  async getScanPage(pageId): Promise<ScanPageRecord> {
    return mapScanPage(await apiRequest<ApiScanPage>(`/api/v1/scan-pages/${encodeURIComponent(pageId)}`))
  },

  async startCapture(pageId, idempotencyKey): Promise<Capture> {
    return mapCapture(await apiRequest<ApiCapture>(`/api/v1/scan-pages/${encodeURIComponent(pageId)}/captures`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    }))
  },

  async getCapture(captureId): Promise<Capture> {
    return mapCapture(await apiRequest<ApiCapture>(`/api/v1/captures/${encodeURIComponent(captureId)}`))
  },

  async getLatestCapture(scanId, pageId): Promise<Capture | null> {
    const source = await apiRequest<ApiCapture | undefined>(`/api/v1/scans/${encodeURIComponent(scanId)}/scan-pages/${encodeURIComponent(pageId)}/captures/latest-ready`)
    return source ? mapCapture(source) : null
  },

  async getSnapshot(captureId): Promise<PageSnapshot> {
    const source = await apiRequest<ApiCaptureSnapshot>(`/api/v1/captures/${encodeURIComponent(captureId)}/snapshot`)
    return {
      id: source.id,
      scanPageId: source.scanPageId,
      status: source.status,
      createdAt: formatInstant(source.createdAt),
      finalUrl: source.finalUrl,
      viewport: source.viewport,
      resourceCount: source.resourceCount,
      capturedResourceCount: source.capturedResourceCount,
      totalBytes: source.totalBytes,
      measurementProfile: source.measurementProfile,
      browserVersion: source.browserVersion,
      rendered: source.rendered,
      diff: source.diff,
      performance: source.performance,
      artifacts: source.artifacts,
      reconstruction: source.reconstruction,
      resources: source.resources,
    }
  },

  async getCaptureScreenshot(captureId): Promise<Blob> {
    return apiBlobRequest(`/api/v1/captures/${encodeURIComponent(captureId)}/artifacts/screenshot`)
  },

  async getCapturedResource(captureId, resourceId): Promise<Blob> {
    return apiBlobRequest(
      `/api/v1/captures/${encodeURIComponent(captureId)}/resources/${encodeURIComponent(resourceId)}/content`,
    )
  },

  async getReconstructionArchive(reconstructionId): Promise<Blob> {
    return apiBlobRequest(
      `/api/v1/reconstructions/${encodeURIComponent(reconstructionId)}/artifacts/archive`,
    )
  },
}

function mapScanPage(source: ApiScanPage): ScanPageRecord {
  return {
    id: source.id,
    scanId: source.scanId,
    path: source.path,
    url: source.url,
    statusCode: source.statusCode ?? undefined,
    outcome: source.outcome,
    responseTimeMs: source.responseTimeMs ?? undefined,
    responseBytes: source.responseBytes ?? undefined,
    title: source.title ?? undefined,
		description: source.description ?? undefined,
		metaKeywords: source.metaKeywords ?? undefined,
		canonicalUrl: source.canonicalUrl ?? undefined,
		canonicalRelation: source.canonicalRelation,
		metaRobots: source.metaRobots ?? undefined,
		xRobotsTag: source.xRobotsTag ?? undefined,
		htmlLang: source.htmlLang ?? undefined,
		indexable: source.indexable,
		indexabilityReason: source.indexabilityReason,
    h1: source.h1 ?? undefined,
		h1Values: source.h1Values,
		h2: source.h2,
		h3: source.h3,
		h4: source.h4,
		h5: source.h5,
		h6: source.h6,
		hreflang: source.hreflang,
		openGraph: {
			title: source.openGraph.title ?? undefined,
			description: source.openGraph.description ?? undefined,
			imageUrl: source.openGraph.imageUrl ?? undefined,
		},
		structuredData: source.structuredData,
    links: source.links,
    images: source.images,
    scripts: source.scripts,
    stylesheets: source.stylesheets,
		timing: {
			dnsMillis: source.timing.dnsMillis ?? undefined,
			connectMillis: source.timing.connectMillis ?? undefined,
			tlsMillis: source.timing.tlsMillis ?? undefined,
			ttfbMillis: source.timing.ttfbMillis ?? undefined,
			totalMillis: source.timing.totalMillis ?? undefined,
		},
    findings: source.findings,
    observedAt: formatInstant(source.observedAt),
  }
}

function mapWebsite(source: ApiWebsite): Website {
  return {
    id: source.id,
    name: source.name,
    url: source.canonicalUrl,
    hostname: source.hostname,
    latestScanId: source.latestScan?.id,
    latestStatus: source.latestScan?.status,
    updatedAt: formatInstant(source.updatedAt),
    pageCount: source.pageCount,
    findingCount: source.findingCount,
  }
}

function mapScan(source: ApiScan): Scan {
  return {
    id: source.id,
    websiteId: source.websiteId,
    status: source.status,
    createdAt: formatInstant(source.createdAt),
    startedAt: source.startedAt ? formatInstant(source.startedAt) : undefined,
    finishedAt: source.finishedAt ? formatInstant(source.finishedAt) : undefined,
    duration: formatDuration(source.durationMs),
    progress: source.progress,
    findingCount: source.findingCount,
    collectorVersion: source.collectorVersion,
    effectiveConfig: source.effectiveConfig,
    terminalReason: source.terminalReason ?? undefined,
  }
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function mapCapture(source: ApiCapture): Capture {
  return {
    id: source.id,
    scanId: source.scanId,
    pageId: source.pageId,
    status: source.status,
    targetUrl: source.targetUrl,
    measurementProfile: source.measurementProfile,
    analyticsExpectedCount: source.analyticsExpectedCount,
    analyticsPublishedCount: source.analyticsPublishedCount,
    objectCount: source.objectCount,
    totalObjectBytes: source.totalObjectBytes,
    terminalCode: source.terminalCode ?? undefined,
    terminalMessage: source.terminalMessage ?? undefined,
    createdAt: formatInstant(source.createdAt),
  }
}
