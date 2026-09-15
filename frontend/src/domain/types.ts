export type ScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'CANCELLED'

export type CaptureStatus = 'QUEUED' | 'DISPATCHED' | 'RUNNING' | 'INDEXING' | 'COMPLETED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'CANCELLED'
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
  startedAt?: string
  finishedAt?: string
  duration: string
  progress: ScanProgress
  findingCount: number
  collectorVersion?: string
  effectiveConfig?: {
    maxPages: number
    maxDepth: number
    maxResponseBytes: number
    maxDurationSeconds: number
    maxRedirects: number
    concurrency: number
  }
  terminalReason?: { code: string; message: string }
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
  description?: string
  metaKeywords?: string
  canonicalUrl?: string
  canonicalRelation?: 'MISSING' | 'SELF' | 'NON_SELF'
  metaRobots?: string
  xRobotsTag?: string
  htmlLang?: string
  indexable?: boolean
  indexabilityReason?: string
  h1?: string
  h1Values?: string[]
  h2?: string[]
  h3?: string[]
  h4?: string[]
  h5?: string[]
  h6?: string[]
  hreflang?: Array<{ language: string; url: string }>
  openGraph?: { title?: string; description?: string; imageUrl?: string }
  structuredData?: {
    types: string[]
    itemCount: number
    validCount: number
    errorCount: number
    warningCount: number
    issueCodes: string[]
  }
  links: number
  images: number
  scripts: number
  stylesheets: number
  timing?: {
    dnsMillis?: number
    connectMillis?: number
    tlsMillis?: number
    ttfbMillis?: number
    totalMillis?: number
  }
  findings: Finding[]
  observedAt?: string
}

export interface ScanPagesReport {
  items: ScanPageRecord[]
  analyticsExpectedCount: number
  analyticsPublishedCount: number
  analyticsWatermark: string | null
  fresh: boolean
  nextCursor?: string
}

export interface CapturedResource {
  id: string
  url: string
  method: string
  status: number
  type: string
  contentType: string
  sizeBytes: number
  durationMs: number
  bodyCaptured: boolean
  capturedBodyId: string | null
  capturedBodyBytes: number
  bodySha256: string | null
  bodyTruncated: boolean
}

export interface StaticReconstruction {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' | 'EXPIRED'
  kind: 'STATIC_PAGE_ARCHIVE'
  engineVersion: string
  packagedCount: number
  skippedCount: number
  archiveBytes: number | null
  completenessCode: string | null
  failureCode: string | null
  expiresAt: string | null
  downloadAvailable: boolean
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
  measurementProfile?: string
  browserVersion?: string
  capturedResourceCount?: number
  rendered?: {
    title: string
    description: string
    canonicalUrl: string
    metaRobots: string
    h1: string[]
    wordCount: number
    linkCount: number
    imageCount: number
    openGraph: { title: string; description: string; imageUrl: string }
    schemaOrgTypes: string[]
  }
  diff?: {
    titleChanged: boolean
    descriptionChanged: boolean
    canonicalChanged: boolean
    h1Changed: boolean
    contentChanged: boolean
    linkCountDelta: number
    imageCountDelta: number
    schemaTypesChanged: boolean
  }
  performance?: Record<'lcp' | 'cls' | 'ttfb', {
    status: 'AVAILABLE' | 'UNAVAILABLE'
    value: number | null
    unit: 'ms' | 'score'
    source: string
    profileVersion: string
    unavailableReason: string | null
  }>
  artifacts?: { renderedHtmlBytes: number; screenshotBytes: number }
  reconstruction?: StaticReconstruction | null
  resources: CapturedResource[]
}

export interface Capture {
  id: string
  scanId: string
  pageId: string
  status: CaptureStatus
  targetUrl: string
  measurementProfile: string
  analyticsExpectedCount: number
  analyticsPublishedCount: number
  objectCount: number
  totalObjectBytes: number
  terminalCode?: string
  terminalMessage?: string
  createdAt: string
}

export interface ServiceError {
  code: string
  message: string
  requestId: string
}
