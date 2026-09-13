import type { PageSnapshot, Scan, ScanPageRecord, Website } from '../domain/types'

export const websites: Website[] = [
  { id: 'site-1', name: 'Evomi Marketing', url: 'https://evomi.com/', hostname: 'evomi.com', latestScanId: 'scan-104', latestStatus: 'RUNNING', updatedAt: '2 phút trước', pageCount: 18, findingCount: 3 },
  { id: 'site-2', name: 'WebLens Docs', url: 'https://docs.weblens.dev/', hostname: 'docs.weblens.dev', latestScanId: 'scan-201', latestStatus: 'COMPLETED', updatedAt: 'Hôm qua, 16:42', pageCount: 32, findingCount: 0 },
  { id: 'site-3', name: 'Sandbox API', url: 'https://api.sandbox.dev/', hostname: 'api.sandbox.dev', latestScanId: 'scan-301', latestStatus: 'PARTIAL_SUCCESS', updatedAt: '3 ngày trước', pageCount: 9, findingCount: 5 },
]

export const scans: Scan[] = [
  { id: 'scan-104', websiteId: 'site-1', status: 'RUNNING', createdAt: 'Hôm nay, 20:14', duration: '00:18', progress: { discovered: 18, queued: 6, processed: 12, succeeded: 11, failed: 1, limit: 25 }, findingCount: 3 },
  { id: 'scan-103', websiteId: 'site-1', status: 'COMPLETED', createdAt: 'Hôm qua, 18:02', duration: '01:24', progress: { discovered: 18, queued: 0, processed: 18, succeeded: 18, failed: 0, limit: 25 }, findingCount: 2 },
  { id: 'scan-102', websiteId: 'site-1', status: 'PARTIAL_SUCCESS', createdAt: '06/09/2026, 09:31', duration: '02:00', progress: { discovered: 25, queued: 0, processed: 25, succeeded: 22, failed: 3, limit: 25 }, findingCount: 6 },
  { id: 'scan-101', websiteId: 'site-1', status: 'CANCELLED', createdAt: '04/09/2026, 11:08', duration: '00:17', progress: { discovered: 14, queued: 0, processed: 7, succeeded: 7, failed: 0, limit: 25 }, findingCount: 0 },
  { id: 'scan-201', websiteId: 'site-2', status: 'COMPLETED', createdAt: 'Hôm qua, 16:42', duration: '01:48', progress: { discovered: 32, queued: 0, processed: 32, succeeded: 32, failed: 0, limit: 50 }, findingCount: 0 },
]

export const scanPages: ScanPageRecord[] = [
  {
    id: 'page-home', scanId: 'scan-103', path: '/', url: 'https://evomi.com/', statusCode: 200, outcome: 'warning', responseTimeMs: 684, responseBytes: 341600,
    title: 'Evomi | Ethical Proxies & Web Data From $0.49/GB', h1: 'Proxies built for reliable web data', links: 74, images: 18, scripts: 29, stylesheets: 2,
    findings: [
      { id: 'finding-1', severity: 'warning', title: 'HTML có kích thước lớn', description: 'Tài liệu HTML vượt ngưỡng cảnh báo 300 KB của bộ quy tắc v1.', evidence: '341.600 bytes > 300.000 bytes' },
      { id: 'finding-2', severity: 'info', title: 'Phản hồi chậm hơn mục tiêu', description: 'Thời gian phản hồi ban đầu cao hơn mục tiêu quan sát 500 ms.', evidence: '684 ms > 500 ms' },
    ],
  },
  { id: 'page-pricing', scanId: 'scan-103', path: '/pricing', url: 'https://evomi.com/pricing', statusCode: 200, outcome: 'success', responseTimeMs: 312, responseBytes: 186204, title: 'Pricing | Evomi', h1: 'Simple proxy pricing', links: 42, images: 7, scripts: 22, stylesheets: 2, findings: [] },
  { id: 'page-locations', scanId: 'scan-103', path: '/locations', url: 'https://evomi.com/locations', statusCode: 503, outcome: 'failed', links: 0, images: 0, scripts: 0, stylesheets: 0, findings: [{ id: 'finding-3', severity: 'critical', title: 'Trang không khả dụng', description: 'Máy chủ trả về lỗi tạm thời khi crawler truy cập trang.', evidence: 'HTTP 503 Service Unavailable' }] },
]

export const snapshot: PageSnapshot = {
  id: 'snapshot-1', scanPageId: 'page-home', status: 'COMPLETED', createdAt: 'Hôm nay, 20:18', finalUrl: 'https://evomi.com/', viewport: '1440 × 900', resourceCount: 126, totalBytes: 4289412,
  resources: [
    { id: 'res-1', url: 'https://evomi.com/', method: 'GET', status: 200, type: 'document', contentType: 'text/html', sizeBytes: 341600, durationMs: 684, bodyCaptured: false, capturedBodyId: null, capturedBodyBytes: 0, bodySha256: null, bodyTruncated: false },
    { id: 'res-2', url: 'https://evomi.com/_next/static/chunks/app.css', method: 'GET', status: 200, type: 'stylesheet', contentType: 'text/css', sizeBytes: 151295, durationMs: 143, bodyCaptured: true, capturedBodyId: 'body-2', capturedBodyBytes: 151295, bodySha256: '9b16dca927d87a20ce4f10cd87afcd50f018dc0826f77accb07a2e16d4564e8d', bodyTruncated: false },
    { id: 'res-3', url: 'https://evomi.com/_next/static/chunks/main.js', method: 'GET', status: 200, type: 'script', contentType: 'application/javascript', sizeBytes: 284112, durationMs: 221, bodyCaptured: true, capturedBodyId: 'body-3', capturedBodyBytes: 262144, bodySha256: 'a5bc6acac115f04d649f9f92019a41e5b22e2eeec7dfc4cbbf0532fa14975472', bodyTruncated: true },
    { id: 'res-4', url: 'https://evomi.com/images/hero.webp', method: 'GET', status: 200, type: 'image', contentType: 'image/webp', sizeBytes: 482310, durationMs: 316, bodyCaptured: true, capturedBodyId: 'body-4', capturedBodyBytes: 482310, bodySha256: '12db844ab1d377b58769c17b8d3b7289e75200fe79a9f6fc62b1f1bb78633027', bodyTruncated: false },
    { id: 'res-5', url: 'https://evomi.com/fonts/hanken.woff2', method: 'GET', status: 200, type: 'font', contentType: 'font/woff2', sizeBytes: 48216, durationMs: 98, bodyCaptured: true, capturedBodyId: 'body-5', capturedBodyBytes: 48216, bodySha256: '8a8ddfbb82d33f805259854211849ec36c6ec3b332a3a45fe9b7362b8af72f20', bodyTruncated: false },
    { id: 'res-6', url: 'https://api.trafficguard.ai/check', method: 'POST', status: 204, type: 'fetch', contentType: 'application/json', sizeBytes: 0, durationMs: 267, bodyCaptured: false, capturedBodyId: null, capturedBodyBytes: 0, bodySha256: null, bodyTruncated: false },
  ],
}
