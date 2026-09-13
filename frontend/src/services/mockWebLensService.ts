import { scanPages, scans, snapshot, websites } from '../data/mockData'
import type { Capture, PageSnapshot, Scan, ScanPageRecord, ScanPagesReport, ServiceError, Website } from '../domain/types'

const delay = (milliseconds = 260) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

export interface WebLensService {
  listWebsites(): Promise<Website[]>
  getWebsite(id: string): Promise<Website>
  createWebsite(name: string, url: string): Promise<Website>
  listScans(websiteId: string): Promise<Scan[]>
  getScan(id: string): Promise<Scan>
  startScan(websiteId: string, idempotencyKey: string): Promise<Scan>
  cancelScan(id: string): Promise<Scan>
  listScanPages(scanId: string, cursor?: string): Promise<ScanPagesReport>
  getScanPage(id: string): Promise<ScanPageRecord>
  startCapture(pageId: string, idempotencyKey: string): Promise<Capture>
  getCapture(id: string): Promise<Capture>
  getLatestCapture(scanId: string, pageId: string): Promise<Capture | null>
  getSnapshot(id: string): Promise<PageSnapshot>
  getCaptureScreenshot(id: string): Promise<Blob>
}

const demoWebsites = [...websites]
const demoScans = [...scans]

function notFound(entity: string): ServiceError {
  return { code: 'DEMO_NOT_FOUND', message: `Không tìm thấy ${entity} trong bộ dữ liệu demo.`, requestId: 'demo-req-7f31' }
}

export const mockWebLensService: WebLensService = {
  async listWebsites() { await delay(); return demoWebsites },
  async getWebsite(id) { await delay(); const item = demoWebsites.find((website) => website.id === id); if (!item) throw notFound('website'); return item },
  async createWebsite(name, url) { await delay(); const parsed = new URL(url); const website: Website = { id: `site-${crypto.randomUUID()}`, name, url: parsed.toString(), hostname: parsed.hostname, updatedAt: 'Vừa xong', pageCount: 0, findingCount: 0 }; demoWebsites.unshift(website); return website },
  async listScans(websiteId) { await delay(); return demoScans.filter((scan) => scan.websiteId === websiteId) },
  async getScan(id) { await delay(); const item = demoScans.find((scan) => scan.id === id); if (!item) throw notFound('lần quét'); return item },
  async startScan(websiteId) { await delay(); const scan: Scan = { id: `scan-${crypto.randomUUID()}`, websiteId, status: 'QUEUED', createdAt: 'Vừa xong', duration: '—', progress: { discovered: 0, queued: 0, processed: 0, succeeded: 0, failed: 0, limit: 25 }, findingCount: 0 }; demoScans.unshift(scan); return scan },
  async cancelScan(id) { await delay(); const index = demoScans.findIndex((scan) => scan.id === id); if (index < 0) throw notFound('lần quét'); const cancelled = { ...demoScans[index], status: 'CANCELLED' as const }; demoScans[index] = cancelled; return cancelled },
  async listScanPages(scanId) {
    await delay()
    const items = scanId === 'scan-104' ? scanPages : scanPages.filter((page) => page.scanId === scanId)
    return {
      items,
      analyticsExpectedCount: items.length,
      analyticsPublishedCount: items.length,
      analyticsWatermark: items.length > 0 ? 'Vừa xong' : null,
      fresh: true,
      nextCursor: undefined,
    }
  },
  async getScanPage(id) { await delay(); const item = scanPages.find((page) => page.id === id); if (!item) throw notFound('trang đã quét'); return item },
  async startCapture(pageId) { await delay(); return { id: snapshot.id, scanId: 'scan-103', pageId, status: 'COMPLETED', targetUrl: snapshot.finalUrl, measurementProfile: 'desktop-lab-v1', analyticsExpectedCount: 1, analyticsPublishedCount: 1, objectCount: 2, totalObjectBytes: snapshot.totalBytes, createdAt: snapshot.createdAt } },
  async getCapture(id) { await delay(); if (id !== snapshot.id) throw notFound('capture'); return { id, scanId: 'scan-103', pageId: snapshot.scanPageId, status: 'COMPLETED', targetUrl: snapshot.finalUrl, measurementProfile: 'desktop-lab-v1', analyticsExpectedCount: 1, analyticsPublishedCount: 1, objectCount: 2, totalObjectBytes: snapshot.totalBytes, createdAt: snapshot.createdAt } },
  async getLatestCapture(scanId, pageId) { await delay(); return scanId === 'scan-103' && pageId === snapshot.scanPageId ? { id: snapshot.id, scanId, pageId, status: 'COMPLETED', targetUrl: snapshot.finalUrl, measurementProfile: 'desktop-lab-v1', analyticsExpectedCount: 1, analyticsPublishedCount: 1, objectCount: 2, totalObjectBytes: snapshot.totalBytes, createdAt: snapshot.createdAt } : null },
  async getSnapshot(id) { await delay(); if (id !== snapshot.id) throw notFound('bản chụp'); return snapshot },
  async getCaptureScreenshot() { throw new Error('Ảnh screenshot không có trong chế độ mock.') },
}
