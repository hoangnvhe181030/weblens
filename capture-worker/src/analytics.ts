import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Config } from './config.js'
import type { ClaimedOutbox } from './database.js'
import type { CaptureResult } from './types.js'

interface AnalyticsPayload {
  schemaVersion: number
  batchId: string
  ownerId: string
  captureRequestId: string
  scanId: string
  pageId: string
  recordVersion: number
  result: Omit<CaptureResult, 'html' | 'screenshot' | 'resourceBodies'> & {
    resourceBodies: Array<{
      resourceId: string
      sequence: number
      url: string
      resourceType: string
      mimeType: string
      bodyBytes: number
      bodySha256: string
      wasTruncated: boolean
    }>
  }
}

export class CaptureAnalytics {
  private readonly client: ClickHouseClient
  private readonly defaultClient: ClickHouseClient

  constructor(private readonly config: Config) {
    const common = {
      url: config.clickhouseUrl,
      username: config.clickhouseUsername,
      password: config.clickhousePassword,
    }
    this.client = createClient({ ...common, database: config.clickhouseDatabase })
    this.defaultClient = createClient({ ...common, database: 'default' })
  }

  async migrate(directory = resolve('migrations/clickhouse')): Promise<void> {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of files) {
      const script = await readFile(resolve(directory, file), 'utf8')
      for (const statement of splitStatements(script)) {
        await this.defaultClient.command({ query: statement })
      }
    }
  }

  async ping(): Promise<void> {
    await this.client.ping()
  }

  async write(outbox: ClaimedOutbox): Promise<void> {
    const payload = outbox.payload as unknown as AnalyticsPayload
    const receipt = await this.client.query({
      query: `select count() as count from ingestion_receipts final
        where owner_id={owner:UUID} and capture_request_id={capture:UUID} and batch_id={batch:UUID}`,
      query_params: { owner: payload.ownerId, capture: payload.captureRequestId, batch: payload.batchId },
      format: 'JSONEachRow',
    })
    const rows = await receipt.json<{ count: string }>()
    if (Number(rows[0]?.count ?? 0) > 0) return
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
    const observedAt = payload.result.observedAt.replace('T', ' ').replace('Z', '')
    const rendered = payload.result.rendered
    const diff = payload.result.diff
    const performance = payload.result.performance
    await this.client.insert({
      table: 'rendered_page_metrics',
      format: 'JSONEachRow',
      values: [{
        owner_id: payload.ownerId,
        capture_request_id: payload.captureRequestId,
        scan_id: payload.scanId,
        page_id: payload.pageId,
        record_version: payload.recordVersion,
        is_deleted: 0,
        schema_version: payload.schemaVersion,
        final_url: payload.result.finalUrl,
        document_title: rendered.title,
        meta_description: rendered.description,
        canonical_url: rendered.canonicalUrl,
        meta_robots: rendered.metaRobots,
        h1: rendered.h1,
        word_count: rendered.wordCount,
        link_count: rendered.linkCount,
        image_count: rendered.imageCount,
        open_graph_title: rendered.openGraph.title,
        open_graph_description: rendered.openGraph.description,
        open_graph_image_url: rendered.openGraph.imageUrl,
        schema_org_types: rendered.schemaOrgTypes,
        title_changed: Number(diff.titleChanged),
        description_changed: Number(diff.descriptionChanged),
        canonical_changed: Number(diff.canonicalChanged),
        h1_changed: Number(diff.h1Changed),
        content_changed: Number(diff.contentChanged),
        link_count_delta: diff.linkCountDelta,
        image_count_delta: diff.imageCountDelta,
        schema_types_changed: Number(diff.schemaTypesChanged),
        lcp_status: performance.lcp.status,
        lcp_millis: performance.lcp.value ?? 0,
        lcp_unavailable_reason: performance.lcp.unavailableReason ?? '',
        cls_status: performance.cls.status,
        cls_value: performance.cls.value ?? 0,
        cls_unavailable_reason: performance.cls.unavailableReason ?? '',
        ttfb_status: performance.ttfb.status,
        ttfb_millis: performance.ttfb.value ?? 0,
        ttfb_unavailable_reason: performance.ttfb.unavailableReason ?? '',
        measurement_profile: performance.lcp.profileVersion,
        browser_version: payload.result.browserVersion,
        observed_at: observedAt,
        ingested_at: now,
      }],
    })
    if (payload.result.network.length) {
      await this.client.insert({
        table: 'network_requests',
        format: 'JSONEachRow',
        values: payload.result.network.map((record) => ({
          owner_id: payload.ownerId,
          capture_request_id: payload.captureRequestId,
          request_id: record.requestId,
          request_sequence: record.sequence,
          record_version: payload.recordVersion,
          url: record.url,
          method: record.method,
          resource_type: record.resourceType,
          status_code: record.statusCode,
          mime_type: record.mimeType,
          response_bytes: record.responseBytes,
          duration_ms: record.durationMs,
          failure_code: record.failureCode,
          observed_at: observedAt,
          ingested_at: now,
        })),
      })
    }
    if (payload.result.resourceBodies.length) {
      await this.client.insert({
        table: 'captured_resources',
        format: 'JSONEachRow',
        values: payload.result.resourceBodies.map((resource) => ({
          owner_id: payload.ownerId,
          capture_request_id: payload.captureRequestId,
          resource_id: resource.resourceId,
          record_version: payload.recordVersion,
          request_sequence: resource.sequence,
          url: resource.url,
          resource_type: resource.resourceType,
          mime_type: resource.mimeType,
          body_bytes: resource.bodyBytes,
          body_sha256: resource.bodySha256,
          was_truncated: Number(resource.wasTruncated),
          observed_at: observedAt,
          ingested_at: now,
        })),
      })
    }
    await this.client.insert({
      table: 'ingestion_receipts',
      format: 'JSONEachRow',
      values: [{
        owner_id: payload.ownerId,
        capture_request_id: payload.captureRequestId,
        batch_id: payload.batchId,
        payload_sha256: outbox.payloadSha256.toString('hex'),
        rendered_rows: 1,
        network_rows: payload.result.network.length,
        resource_rows: payload.result.resourceBodies.length,
        schema_version: payload.schemaVersion,
        ingested_at: now,
      }],
    })
  }

  async listResources(ownerId: string, captureId: string): Promise<Record<string, unknown>[]> {
    const result = await this.client.query({
      query: `select request_id as id,url,method,status_code as status,resource_type as type,
        mime_type as contentType,response_bytes as sizeBytes,duration_ms as durationMs
        from network_requests final
        where owner_id={owner:UUID} and capture_request_id={capture:UUID}
        order by request_sequence,request_id limit 500`,
      query_params: { owner: ownerId, capture: captureId },
      format: 'JSONEachRow',
    })
    return await result.json<Record<string, unknown>>()
  }

  async close(): Promise<void> {
    await Promise.all([this.client.close(), this.defaultClient.close()])
  }
}

function splitStatements(script: string): string[] {
  return script.split(';').map((candidate) => candidate
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim())
    .filter(Boolean)
}
