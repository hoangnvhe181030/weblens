import type { PageSnapshot, Scan, ScanPageRecord, Website } from '../domain/types'
import type { WebLensService } from '../services/mockWebLensService'
import { apiRequest } from './apiClient'
import type { ApiPage, ApiScan, ApiScanPage, ApiScanPages, ApiWebsite } from './contracts'

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

  async listScanPages(scanId): Promise<ScanPageRecord[]> {
    const response = await apiRequest<ApiScanPages>(`/api/v1/scans/${encodeURIComponent(scanId)}/pages`)
    return response.items.map(mapScanPage)
  },

  async getScanPage(pageId): Promise<ScanPageRecord> {
    return mapScanPage(await apiRequest<ApiScanPage>(`/api/v1/scan-pages/${encodeURIComponent(pageId)}`))
  },

  getSnapshot(): Promise<PageSnapshot> {
    return unsupported('Browser capture')
  },
}

function mapScanPage(source: ApiScanPage): ScanPageRecord {
  return {
    id: source.id,
    scanId: source.scanId,
    path: source.path,
    url: source.url,
    statusCode: source.statusCode,
    outcome: source.outcome,
    responseTimeMs: source.responseTimeMs,
    responseBytes: source.responseBytes,
    title: source.title,
    h1: source.h1,
    links: source.links,
    images: source.images,
    scripts: source.scripts,
    stylesheets: source.stylesheets,
    findings: source.findings,
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
    duration: formatDuration(source.durationMs),
    progress: source.progress,
    findingCount: source.findingCount,
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

function unsupported<T>(feature: string): Promise<T> {
  return Promise.reject(new Error(`${feature} chưa có API trong backend foundation V1.`))
}
