export type ScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'CANCELLED'

export type CaptureStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type FindingSeverity = 'critical' | 'warning' | 'info'

export interface Website {
  id: string
  name: string
  url: string
  hostname: string
  latestScanId?: string
  latestStatus?: ScanStatus
  updatedAt: string
  pageCount: number
  findingCount: number
}

export interface ScanProgress {
  discovered: number
  queued: number
  processed: number
  succeeded: number
  failed: number
  limit: number
}

export interface Scan {
  id: string
  websiteId: string
  status: ScanStatus
  createdAt: string
  duration: string
  progress: ScanProgress
  findingCount: number
}

export interface Finding {
  id: string
  severity: FindingSeverity
  title: string
  description: string
  evidence: string
}

export interface ScanPageRecord {
  id: string
  scanId: string
  path: string
  url: string
  statusCode?: number
  outcome: 'success' | 'warning' | 'failed'
  responseTimeMs?: number
  responseBytes?: number
  title?: string
  h1?: string
  links: number
  images: number
  scripts: number
  stylesheets: number
  findings: Finding[]
}

export interface CapturedResource {
  id: string
  url: string
  method: 'GET' | 'POST'
  status: number
  type: 'document' | 'stylesheet' | 'script' | 'image' | 'font' | 'fetch'
  contentType: string
  sizeBytes: number
  durationMs: number
}

export interface PageSnapshot {
  id: string
  scanPageId: string
  status: CaptureStatus
  createdAt: string
  finalUrl: string
  viewport: string
  resourceCount: number
  totalBytes: number
  resources: CapturedResource[]
}

export interface ServiceError {
  code: string
  message: string
  requestId: string
}
