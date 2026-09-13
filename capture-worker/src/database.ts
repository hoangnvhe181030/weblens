import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import type { CaptureCommandEnvelope, CaptureResult, StoredObject } from './types.js'

export interface ClaimedJob {
  id: string
  ownerId: string
  scanId: string
  pageId: string
  correlationId: string
  payload: CaptureCommandEnvelope['payload']
  leaseOwner: string
  leaseGeneration: number
  attemptCount: number
}

export interface ClaimedOutbox {
  id: string
  jobId: string
  ownerId: string
  payload: Record<string, unknown>
  payloadSha256: Buffer
  leaseOwner: string
}

export interface ClaimedEvent {
  messageId: string
  payload: Record<string, unknown>
  leaseOwner: string
}

export interface ScreenshotReference {
  bucket: string
  key: string
  bytes: number
  sha256Hex: string
  expiresAt: Date
}

export interface ResourceReference extends ScreenshotReference {
  contentType: string
}

export class CaptureDatabase {
  readonly pool: Pool

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 })
  }

  async migrate(directory = resolve('migrations/postgresql')): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', ['weblens-capture-migrations'])
      await client.query(`create table if not exists capture_schema_migrations (
        version text primary key, applied_at timestamptz not null default now())`)
      const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
      for (const file of files) {
        const exists = await client.query<{ exists: boolean }>(
          'select exists(select 1 from capture_schema_migrations where version = $1) as exists', [file],
        )
        if (exists.rows[0]?.exists) continue
        await client.query('begin')
        try {
          await client.query(await readFile(resolve(directory, file), 'utf8'))
          await client.query('insert into capture_schema_migrations(version) values ($1) on conflict do nothing', [file])
          await client.query('commit')
        } catch (error) {
          await client.query('rollback')
          throw error
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', ['weblens-capture-migrations']).catch(() => undefined)
      client.release()
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1')
  }

  async acceptCommand(envelope: CaptureCommandEnvelope): Promise<boolean> {
    const payloadBytes = Buffer.from(JSON.stringify(envelope), 'utf8')
    const hash = createHash('sha256').update(payloadBytes).digest()
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [envelope.messageId])
      const existing = await client.query<{ command_payload_sha256: Buffer }>(
        'select command_payload_sha256 from capture_jobs where command_message_id = $1', [envelope.messageId],
      )
      if (existing.rowCount) {
        const stored = existing.rows[0]?.command_payload_sha256
        if (!stored || stored.length !== hash.length || !timingSafeEqual(stored, hash)) {
          throw new Error('MESSAGE_ID_COLLISION')
        }
        await client.query('commit')
        return true
      }
      const payload = envelope.payload
      await client.query(`insert into capture_jobs (
          id, command_message_id, command_payload_sha256, owner_id, scan_id, page_id,
          correlation_id, command_version, status, target_url, command_payload,
          available_at, accepted_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$10::jsonb,now(),now(),now())`, [
        payload.captureRequestId, envelope.messageId, hash, payload.ownerId, payload.scanId,
        payload.pageId, envelope.correlationId, envelope.aggregateVersion, payload.targetUrl,
        JSON.stringify(payload),
      ])
      await client.query('commit')
      return false
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async claimJob(workerId: string): Promise<ClaimedJob | null> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query(`update capture_jobs set status='QUEUED', lease_owner=null, lease_expires_at=null,
          available_at=now(), updated_at=now()
        where status='RENDERING' and lease_expires_at <= now() and attempt_count < 3`)
      const result = await client.query<{
        id: string; owner_id: string; scan_id: string; page_id: string; correlation_id: string
        command_payload: CaptureCommandEnvelope['payload']; lease_owner: string; lease_generation: string; attempt_count: number
      }>(`with candidate as (
          select id from capture_jobs
          where status='QUEUED' and available_at <= now() and attempt_count < 3
          order by available_at, accepted_at, id for update skip locked limit 1
        ) update capture_jobs job
        set status='RENDERING', lease_owner=$1, lease_generation=lease_generation+1,
            lease_expires_at=now()+interval '45 seconds', attempt_count=attempt_count+1,
            started_at=coalesce(started_at,now()), updated_at=now()
        from candidate where job.id=candidate.id
        returning job.id,job.owner_id,job.scan_id,job.page_id,job.correlation_id,
          job.command_payload,job.lease_owner,job.lease_generation,job.attempt_count`, [workerId])
      const row = result.rows[0]
      if (!row) {
        await client.query('commit')
        return null
      }
      await this.enqueueEvent(client, row.id, row.owner_id, row.correlation_id, 'RUNNING', 0, 0, 0, 0, null, null)
      await client.query('commit')
      return {
        id: row.id, ownerId: row.owner_id, scanId: row.scan_id, pageId: row.page_id,
        correlationId: row.correlation_id, payload: row.command_payload,
        leaseOwner: row.lease_owner, leaseGeneration: Number(row.lease_generation), attemptCount: row.attempt_count,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async extendLease(job: ClaimedJob): Promise<boolean> {
    const result = await this.pool.query(`update capture_jobs
      set lease_expires_at=now()+interval '45 seconds', updated_at=now()
      where id=$1 and status='RENDERING' and lease_owner=$2 and lease_generation=$3`,
    [job.id, job.leaseOwner, job.leaseGeneration])
    return result.rowCount === 1
  }

  async stageResult(
    job: ClaimedJob,
    result: CaptureResult,
    htmlObject: StoredObject,
    screenshotObject: StoredObject,
    resourceObjects: Array<{ resource: CaptureResult['resourceBodies'][number]; object: StoredObject }>,
  ): Promise<void> {
    const analyticsPayload = {
      schemaVersion: 1,
      batchId: randomUUID(),
      ownerId: job.ownerId,
      captureRequestId: job.id,
      scanId: job.scanId,
      pageId: job.pageId,
      recordVersion: job.leaseGeneration,
      result: {
        ...result,
        html: undefined,
        screenshot: undefined,
        resourceBodies: resourceObjects.map(({ resource }) => ({
          resourceId: resource.resourceId,
          sequence: resource.sequence,
          url: resource.url,
          resourceType: resource.resourceType,
          mimeType: resource.mimeType,
          bodyBytes: resource.body.length,
          bodySha256: createHash('sha256').update(resource.body).digest('hex'),
          wasTruncated: resource.wasTruncated,
        })),
      },
    }
    const encoded = Buffer.from(JSON.stringify(analyticsPayload), 'utf8')
    if (encoded.length > 8_388_608) throw new Error('ANALYTICS_PAYLOAD_TOO_LARGE')
    const hash = createHash('sha256').update(encoded).digest()
    const expected = 1 + result.network.length + resourceObjects.length
    const objectCount = 2 + resourceObjects.length
    const objectBytes = htmlObject.bytes + screenshotObject.bytes
      + resourceObjects.reduce((total, item) => total + item.object.bytes, 0)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const locked = await client.query(`select id from capture_jobs
        where id=$1 and status='RENDERING' and lease_owner=$2 and lease_generation=$3 for update`,
      [job.id, job.leaseOwner, job.leaseGeneration])
      if (!locked.rowCount) throw new Error('STALE_CAPTURE_LEASE')
      const snapshotId = randomUUID()
      await client.query(`insert into page_snapshots (
          id,capture_job_id,owner_id,scan_id,page_id,final_url,viewport_width,viewport_height,
          measurement_profile,browser_version,rendered_metadata,diff_summary,performance_summary,
          network_request_count,captured_resource_count,total_transfer_bytes,storage_bucket,
          html_storage_key,html_sha256,html_bytes,screenshot_storage_key,screenshot_sha256,
          screenshot_bytes,captured_at,expires_at,created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,
          $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24::timestamptz+interval '30 days',now())`, [
        snapshotId, job.id, job.ownerId, job.scanId, job.pageId, result.finalUrl,
        job.payload.viewportWidth, job.payload.viewportHeight, job.payload.measurementProfile,
        result.browserVersion, JSON.stringify(result.rendered), JSON.stringify(result.diff),
        JSON.stringify(result.performance), result.network.length, resourceObjects.length,
        result.totalTransferBytes, htmlObject.bucket, htmlObject.key, htmlObject.sha256,
        htmlObject.bytes, screenshotObject.key, screenshotObject.sha256, screenshotObject.bytes,
        result.observedAt,
      ])
      for (let index = 0; index < resourceObjects.length; index++) {
        const item = resourceObjects[index]
        if (!item) continue
        await client.query(`insert into capture_object_references (
          id,capture_job_id,resource_id,ordinal,storage_bucket,storage_key,content_type,
          byte_size,sha256,delete_after,created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '7 days',now())`, [
          randomUUID(), job.id, item.resource.resourceId, index, item.object.bucket,
          item.object.key, item.object.contentType || 'application/octet-stream', item.object.bytes,
          item.object.sha256,
        ])
      }
      await client.query(`insert into analytics_outbox (
          id,capture_job_id,owner_id,result_version,status,payload,payload_sha256,
          available_at,created_at,updated_at
        ) values ($1,$2,$3,$4,'PENDING',$5::jsonb,$6,now(),now(),now())`, [
        analyticsPayload.batchId, job.id, job.ownerId, job.leaseGeneration,
        encoded.toString('utf8'), hash,
      ])
      await client.query(`update capture_jobs set status='PERSISTING',lease_owner=null,lease_expires_at=null,
          analytics_expected_count=$2,analytics_published_count=0,object_count=$3,total_object_bytes=$4,updated_at=now()
        where id=$1`, [job.id, expected, objectCount, objectBytes])
      await this.enqueueEvent(client, job.id, job.ownerId, job.correlationId, 'INDEXING', expected, 0, objectCount, objectBytes, null, null)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async failJob(job: ClaimedJob, errorCode: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = await client.query<{ attempt_count: number }>(`select attempt_count from capture_jobs
        where id=$1 and status='RENDERING' and lease_owner=$2 and lease_generation=$3 for update`,
      [job.id, job.leaseOwner, job.leaseGeneration])
      const attempt = row.rows[0]?.attempt_count
      if (attempt === undefined) {
        await client.query('rollback')
        return
      }
      if (attempt < 3) {
        await client.query(`update capture_jobs set status='QUEUED',lease_owner=null,lease_expires_at=null,
          available_at=now()+($2::text||' seconds')::interval,terminal_code=$3,updated_at=now() where id=$1`,
        [job.id, Math.min(30, 2 ** attempt), errorCode])
      } else {
        await client.query(`update capture_jobs set status='FAILED',lease_owner=null,lease_expires_at=null,
          terminal_code=$2,terminal_message='Capture failed after bounded retries',finished_at=now(),updated_at=now()
          where id=$1`, [job.id, errorCode])
        await this.enqueueEvent(client, job.id, job.ownerId, job.correlationId, 'FAILED', 0, 0, 0, 0,
          errorCode, 'Capture failed after bounded retries')
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async claimAnalytics(workerId: string): Promise<ClaimedOutbox | null> {
    const result = await this.pool.query<{
      id: string; capture_job_id: string; owner_id: string; payload: Record<string, unknown>
      payload_sha256: Buffer; lease_owner: string
    }>(`with candidate as (
        select id from analytics_outbox
        where (status='PENDING' and available_at<=now()) or (status='CLAIMED' and lease_expires_at<=now())
        order by available_at,created_at,id for update skip locked limit 1
      ) update analytics_outbox outbox set status='CLAIMED',lease_owner=$1,
        lease_expires_at=now()+interval '30 seconds',delivery_attempts=delivery_attempts+1,updated_at=now()
      from candidate where outbox.id=candidate.id
      returning outbox.id,outbox.capture_job_id,outbox.owner_id,outbox.payload,
        outbox.payload_sha256,outbox.lease_owner`, [workerId])
    const row = result.rows[0]
    return row ? {
      id: row.id, jobId: row.capture_job_id, ownerId: row.owner_id,
      payload: row.payload, payloadSha256: row.payload_sha256, leaseOwner: row.lease_owner,
    } : null
  }

  async completeAnalytics(outbox: ClaimedOutbox): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const updated = await client.query(`update analytics_outbox set status='DELIVERED',payload=null,
          lease_owner=null,lease_expires_at=null,delivered_at=now(),last_error_code=null,updated_at=now()
        where id=$1 and status='CLAIMED' and lease_owner=$2 returning capture_job_id`, [outbox.id, outbox.leaseOwner])
      if (!updated.rowCount) throw new Error('STALE_ANALYTICS_LEASE')
      const job = await client.query<{
        owner_id: string; correlation_id: string; analytics_expected_count: number
        object_count: number; total_object_bytes: string
      }>(`update capture_jobs set status='COMPLETED',analytics_published_count=analytics_expected_count,
          finished_at=now(),updated_at=now() where id=$1 and status='PERSISTING'
        returning owner_id,correlation_id,analytics_expected_count,object_count,total_object_bytes`, [outbox.jobId])
      const row = job.rows[0]
      if (!row) throw new Error('CAPTURE_JOB_NOT_PERSISTING')
      await this.enqueueEvent(
        client, outbox.jobId, row.owner_id, row.correlation_id, 'COMPLETED',
        row.analytics_expected_count, row.analytics_expected_count, row.object_count,
        Number(row.total_object_bytes), null, null,
      )
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async retryAnalytics(outbox: ClaimedOutbox, code: string): Promise<void> {
    await this.pool.query(`update analytics_outbox set status=case when delivery_attempts>=20 then 'DEAD' else 'PENDING' end,
      available_at=now()+interval '2 seconds',lease_owner=null,lease_expires_at=null,last_error_code=$3,updated_at=now()
      where id=$1 and status='CLAIMED' and lease_owner=$2`, [outbox.id, outbox.leaseOwner, code])
  }

  async claimEvent(workerId: string): Promise<ClaimedEvent | null> {
    const result = await this.pool.query<{
      message_id: string; payload: Record<string, unknown>; lease_owner: string
    }>(`with candidate as (
        select message_id from event_outbox
        where (status='PENDING' and available_at<=now()) or (status='CLAIMED' and lease_expires_at<=now())
        order by available_at,created_at,message_id for update skip locked limit 1
      ) update event_outbox outbox set status='CLAIMED',lease_owner=$1,
        lease_expires_at=now()+interval '30 seconds',delivery_attempts=delivery_attempts+1
      from candidate where outbox.message_id=candidate.message_id
      returning outbox.message_id,outbox.payload,outbox.lease_owner`, [workerId])
    const row = result.rows[0]
    return row ? { messageId: row.message_id, payload: row.payload, leaseOwner: row.lease_owner } : null
  }

  async completeEvent(event: ClaimedEvent): Promise<void> {
    await this.pool.query(`update event_outbox set status='DELIVERED',lease_owner=null,lease_expires_at=null,
      delivered_at=now(),last_error_code=null where message_id=$1 and status='CLAIMED' and lease_owner=$2`,
    [event.messageId, event.leaseOwner])
  }

  async retryEvent(event: ClaimedEvent, code: string): Promise<void> {
    await this.pool.query(`update event_outbox set status=case when delivery_attempts>=20 then 'DEAD' else 'PENDING' end,
      available_at=now()+interval '2 seconds',lease_owner=null,lease_expires_at=null,last_error_code=$3
      where message_id=$1 and status='CLAIMED' and lease_owner=$2`, [event.messageId, event.leaseOwner, code])
  }

  async getSnapshot(ownerId: string, captureId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`select job.id as capture_id,job.status,job.page_id,job.scan_id,
        snapshot.id as snapshot_id,snapshot.final_url,snapshot.viewport_width,snapshot.viewport_height,
        snapshot.measurement_profile,snapshot.browser_version,snapshot.rendered_metadata,
        snapshot.diff_summary,snapshot.performance_summary,snapshot.network_request_count,
        snapshot.captured_resource_count,snapshot.total_transfer_bytes,snapshot.captured_at,
        snapshot.storage_bucket,snapshot.html_storage_key,snapshot.html_bytes,
        snapshot.screenshot_storage_key,snapshot.screenshot_bytes
      from capture_jobs job left join page_snapshots snapshot on snapshot.capture_job_id=job.id
      where job.id=$1 and job.owner_id=$2`, [captureId, ownerId])
    return result.rows[0] ?? null
  }

  async getScreenshotReference(ownerId: string, captureId: string): Promise<ScreenshotReference | null> {
    const result = await this.pool.query<{
      storage_bucket: string
      screenshot_storage_key: string
      screenshot_bytes: string
      screenshot_sha256_hex: string
      expires_at: Date
    }>(`select storage_bucket,screenshot_storage_key,screenshot_bytes,
          encode(screenshot_sha256,'hex') as screenshot_sha256_hex,expires_at
        from page_snapshots where capture_job_id=$1 and owner_id=$2`, [captureId, ownerId])
    const row = result.rows[0]
    return row ? {
      bucket: row.storage_bucket,
      key: row.screenshot_storage_key,
      bytes: Number(row.screenshot_bytes),
      sha256Hex: row.screenshot_sha256_hex,
      expiresAt: row.expires_at,
    } : null
  }

  async getResourceReference(
    ownerId: string,
    captureId: string,
    resourceId: string,
  ): Promise<ResourceReference | null> {
    const result = await this.pool.query<{
      storage_bucket: string
      storage_key: string
      content_type: string
      byte_size: string
      sha256_hex: string
      delete_after: Date
    }>(`select reference.storage_bucket,reference.storage_key,reference.content_type,
          reference.byte_size,encode(reference.sha256,'hex') as sha256_hex,reference.delete_after
        from capture_object_references reference
        join capture_jobs job on job.id=reference.capture_job_id
        where reference.capture_job_id=$1 and reference.resource_id=$2 and job.owner_id=$3`,
    [captureId, resourceId, ownerId])
    const row = result.rows[0]
    return row ? {
      bucket: row.storage_bucket,
      key: row.storage_key,
      contentType: row.content_type,
      bytes: Number(row.byte_size),
      sha256Hex: row.sha256_hex,
      expiresAt: row.delete_after,
    } : null
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async enqueueEvent(
    client: PoolClient,
    jobId: string,
    ownerId: string,
    correlationId: string,
    status: string,
    expected: number,
    published: number,
    objectCount: number,
    objectBytes: number,
    terminalCode: string | null,
    terminalMessage: string | null,
  ): Promise<void> {
    const versionResult = await client.query<{ event_version: string }>(
      'update capture_jobs set event_version=event_version+1,updated_at=now() where id=$1 returning event_version', [jobId],
    )
    const version = Number(versionResult.rows[0]?.event_version)
    const messageId = randomUUID()
    const occurredAt = new Date().toISOString()
    const payload = {
      messageId,
      aggregateType: 'CAPTURE',
      aggregateId: jobId,
      aggregateVersion: version,
      messageType: 'CAPTURE_PROGRESS',
      contractVersion: 1,
      correlationId,
      occurredAt,
      payload: {
        captureRequestId: jobId,
        ownerId,
        status,
        analyticsExpectedCount: expected,
        analyticsPublishedCount: published,
        objectCount,
        totalObjectBytes: objectBytes,
        terminalCode,
        terminalMessage,
      },
    }
    await client.query(`insert into event_outbox (
      message_id,capture_job_id,event_version,correlation_id,payload,status,available_at,created_at
    ) values ($1,$2,$3,$4,$5::jsonb,'PENDING',now(),now())`, [
      messageId, jobId, version, correlationId, JSON.stringify(payload),
    ])
  }
}
