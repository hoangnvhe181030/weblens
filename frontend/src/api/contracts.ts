export interface ApiPage<T> {
  items: T[]
  page: number
  size: number
  totalItems: number
  totalPages: number
}

export interface ApiFieldError {
  field: string
  message: string
}

export interface ApiProblemDetail {
  title?: string
  detail?: string
  status?: number
  code?: string
  correlationId?: string
  fieldErrors?: ApiFieldError[]
}

export type ApiUserStatus = 'ACTIVE' | 'DISABLED'

export interface ApiUser {
  id: string
  email: string
  displayName: string
  status: ApiUserStatus
}

export interface ApiAuthSession {
  user: ApiUser
  accessToken: string
  tokenType: 'Bearer'
  expiresAt: string
}

export interface ApiLatestScan {
  id: string
  status: ApiScanStatus
  createdAt: string
  finishedAt: string | null
}

export interface ApiWebsite {
  id: string
  name: string
  canonicalUrl: string
  hostname: string
  status: 'ACTIVE' | 'ARCHIVED'
  latestScan: ApiLatestScan | null
  pageCount: number
  findingCount: number
  createdAt: string
  updatedAt: string
}

export type ApiScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'CANCELLED'

export interface ApiScanProgress {
  discovered: number
  queued: number
  processed: number
  succeeded: number
  failed: number
  limit: number
}

export interface ApiEffectiveScanConfig {
  maxPages: number
  maxDepth: number
  maxResponseBytes: number
  maxDurationSeconds: number
  maxRedirects: number
  concurrency: number
}

export interface ApiScan {
  id: string
  websiteId: string
  status: ApiScanStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  progress: ApiScanProgress
  effectiveConfig: ApiEffectiveScanConfig
  collectorVersion: string
  findingCount: number
  terminalReason: { code: string; message: string } | null
}

export interface ApiFinding {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  evidence: string
}

export interface ApiScanPage {
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
  findings: ApiFinding[]
  observedAt: string
}

export interface ApiScanPages {
  items: ApiScanPage[]
  analyticsExpectedCount: number
  analyticsPublishedCount: number
  analyticsWatermark: string | null
  fresh: boolean
}
