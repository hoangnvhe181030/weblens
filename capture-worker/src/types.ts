export interface StaticObservation {
  title: string | null
  description: string | null
  canonicalUrl: string | null
  h1: string | null
  links: number
  images: number
  schemaOrgTypes: string[]
  observedAt: string | null
}

export interface CaptureCommandPayload {
  captureRequestId: string
  ownerId: string
  scanId: string
  pageId: string
  targetUrl: string
  viewportWidth: number
  viewportHeight: number
  timeoutSeconds: number
  maxTotalBytes: number
  maxResourceBytes: number
  maxNetworkRequests: number
  maxResourceBodies: number
  measurementProfile: string
  staticObservation: StaticObservation
}

export interface CaptureCommandEnvelope {
  messageId: string
  aggregateType: 'CAPTURE'
  aggregateId: string
  aggregateVersion: number
  messageType: 'CAPTURE_REQUESTED'
  contractVersion: 1
  correlationId: string
  occurredAt: string
  payload: CaptureCommandPayload
}

export interface RenderedMetadata {
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

export interface DiffSummary {
  staticObservedAt: string | null
  renderedObservedAt: string
  titleChanged: boolean
  descriptionChanged: boolean
  canonicalChanged: boolean
  h1Changed: boolean
  contentChanged: boolean
  linkCountDelta: number
  imageCountDelta: number
  schemaTypesChanged: boolean
}

export interface Measurement {
  status: 'AVAILABLE' | 'UNAVAILABLE'
  value: number | null
  unit: 'ms' | 'score'
  source: 'PLAYWRIGHT_LAB'
  profileVersion: string
  unavailableReason: string | null
}

export interface PerformanceSummary {
  lcp: Measurement
  cls: Measurement
  ttfb: Measurement
}

export interface NetworkRecord {
  requestId: string
  sequence: number
  url: string
  method: string
  resourceType: string
  statusCode: number
  mimeType: string
  responseBytes: number
  durationMs: number
  failureCode: string
}

export interface ResourceBody {
  resourceId: string
  sequence: number
  url: string
  resourceType: string
  mimeType: string
  body: Buffer
  wasTruncated: boolean
}

export interface CaptureResult {
  finalUrl: string
  html: Buffer
  screenshot: Buffer
  rendered: RenderedMetadata
  diff: DiffSummary
  performance: PerformanceSummary
  network: NetworkRecord[]
  resourceBodies: ResourceBody[]
  browserVersion: string
  observedAt: string
  totalTransferBytes: number
}

export interface StoredObject {
  bucket: string
  key: string
  bytes: number
  sha256: Buffer
  contentType: string
}
