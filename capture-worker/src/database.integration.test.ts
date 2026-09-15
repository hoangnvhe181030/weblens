import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { CaptureDatabase } from './database.js'
import type { CaptureCommandEnvelope, CaptureResult, StoredObject } from './types.js'

const databaseUrl = process.env.CAPTURE_TEST_DATABASE_URL

test('duplicate command, lease fencing và analytical completion giữ đúng invariant', {
  skip: databaseUrl ? false : 'CAPTURE_TEST_DATABASE_URL chưa được cấu hình',
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl! })
  const schemaName = `weblens_test_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schemaName}"`)
  const isolatedUrl = new URL(databaseUrl!)
  isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`)
  const database = new CaptureDatabase(isolatedUrl.toString())
  const command = commandEnvelope()

  try {
    await database.migrate()
    const migrations = await database.pool.query<{ version: string }>(
      'select version from capture_schema_migrations order by version',
    )
    assert.deepEqual(migrations.rows.map((row) => row.version), [
      '001_create_capture_runtime.sql',
      '002_create_static_reconstruction.sql',
      '003_index_staged_reconstruction_gc.sql',
    ])
    assert.equal(await database.acceptCommand(command), false)
    assert.equal(await database.acceptCommand(command), true)
    await assert.rejects(
      database.acceptCommand({ ...command, payload: { ...command.payload, targetUrl: 'https://example.org/' } }),
      /MESSAGE_ID_COLLISION/u,
    )

    const firstLease = await database.claimJob(randomUUID())
    assert.ok(firstLease)
    await database.pool.query(
      "update capture_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
      [command.aggregateId],
    )
    const secondLease = await database.claimJob(randomUUID())
    assert.ok(secondLease)
    assert.ok(secondLease.leaseGeneration > firstLease.leaseGeneration)

    const result = captureResult()
    const resource = {
      resourceId: randomUUID(), sequence: 1, url: 'https://example.com/app.js',
      resourceType: 'script', mimeType: 'application/javascript',
      body: Buffer.from('console.log("evidence")', 'utf8'), wasTruncated: false,
    }
    result.resourceBodies = [resource]
    const htmlObject = storedObject('html', result.html)
    const screenshotObject = storedObject('screenshot', result.screenshot)
    const resourceObject = storedObject('resource', resource.body)
    const archiveObject = storedObject('archive', Buffer.from('zip-evidence'))
    const manifestObject = storedObject('manifest', Buffer.from('{"schemaVersion":1}'))
    result.reconstruction.archiveBytes = archiveObject.bytes
    await assert.rejects(
      database.stageResult(firstLease, result, htmlObject, screenshotObject, [], null),
      /STALE_CAPTURE_LEASE/u,
    )
    await assert.rejects(
      database.stageReconstructionArtifacts(firstLease, { archive: archiveObject, manifest: manifestObject }),
      /STALE_CAPTURE_LEASE/u,
    )
    await database.stageReconstructionArtifacts(
      secondLease,
      { archive: archiveObject, manifest: manifestObject },
    )
    const stagedArtifacts = await database.pool.query<{ state: string }>(
      'select state from reconstruction_artifacts order by kind',
    )
    assert.deepEqual(stagedArtifacts.rows.map((row) => row.state), ['STAGED', 'STAGED'])
    await database.stageResult(
      secondLease, result, htmlObject, screenshotObject, [{ resource, object: resourceObject }],
      { archive: archiveObject, manifest: manifestObject },
    )
    const publishedArtifacts = await database.pool.query<{ state: string }>(
      'select state from reconstruction_artifacts order by kind',
    )
    assert.deepEqual(publishedArtifacts.rows.map((row) => row.state), ['PUBLISHED', 'PUBLISHED'])

    const claims = await Promise.all([
      database.claimAnalytics(randomUUID()),
      database.claimAnalytics(randomUUID()),
    ])
    const claimed = claims.filter((value) => value !== null)
    assert.equal(claimed.length, 1)
    await database.completeAnalytics(claimed[0]!)

    const snapshot = await database.getSnapshot(command.payload.ownerId, command.aggregateId)
    assert.equal(snapshot?.['status'], 'COMPLETED')
    assert.equal(snapshot?.['final_url'], 'https://example.com/')
    assert.equal(await database.getScreenshotReference(randomUUID(), command.aggregateId), null)
    assert.equal((await database.getScreenshotReference(command.payload.ownerId, command.aggregateId))?.bytes, 4)
    assert.equal(await database.getResourceReference(randomUUID(), command.aggregateId, resource.resourceId), null)
    assert.equal(await database.getResourceReference(command.payload.ownerId, randomUUID(), resource.resourceId), null)
    const reference = await database.getResourceReference(
      command.payload.ownerId,
      command.aggregateId,
      resource.resourceId,
    )
    assert.equal(reference?.bytes, resource.body.length)
    assert.equal(reference?.key, resourceObject.key)
    const reconstruction = await database.getReconstruction(command.payload.ownerId, command.aggregateId)
    assert.equal(reconstruction?.['reconstruction_status'], 'PUBLISHED')
    assert.equal(reconstruction?.['packaged_count'], 1)
    const reconstructionId = String(reconstruction?.['reconstruction_id'])
    assert.equal(await database.getReconstructionArchiveReference(randomUUID(), reconstructionId), null)
    const archiveReference = await database.getReconstructionArchiveReference(
      command.payload.ownerId,
      reconstructionId,
    )
    assert.equal(archiveReference?.key, archiveObject.key)
    assert.equal(archiveReference?.bytes, archiveObject.bytes)
    assert.equal(archiveReference?.state, 'PUBLISHED')

    await database.pool.query(
      "update reconstruction_artifacts set delete_after=created_at+interval '1 millisecond'",
    )
    const firstExpiredArtifact = await database.claimReconstructionArtifactForDeletion()
    const secondExpiredArtifact = await database.claimReconstructionArtifactForDeletion()
    assert.ok(firstExpiredArtifact)
    assert.ok(secondExpiredArtifact)
    assert.notEqual(firstExpiredArtifact.id, secondExpiredArtifact.id)
    await database.completeReconstructionArtifactDeletion(firstExpiredArtifact)
    await database.completeReconstructionArtifactDeletion(secondExpiredArtifact)
    const expiredReconstruction = await database.getReconstruction(
      command.payload.ownerId,
      command.aggregateId,
    )
    assert.equal(expiredReconstruction?.['reconstruction_status'], 'EXPIRED')
    const expiredReference = await database.getReconstructionArchiveReference(
      command.payload.ownerId,
      reconstructionId,
    )
    assert.equal(expiredReference?.state, 'DELETED')

    const cloneFailureCommand = commandEnvelope()
    await database.acceptCommand(cloneFailureCommand)
    const cloneFailureLease = await database.claimJob(randomUUID())
    assert.ok(cloneFailureLease)
    const cloneFailureResult = captureResult()
    cloneFailureResult.reconstruction = {
      ...cloneFailureResult.reconstruction,
      status: 'FAILED',
      packagedCount: 0,
      inputBytes: 0,
      archiveBytes: null,
      completenessCode: null,
      failureCode: 'CLONE_ARCHIVE_GENERATION_FAILED',
    }
    await database.stageResult(
      cloneFailureLease,
      cloneFailureResult,
      storedObject('failure-html', cloneFailureResult.html),
      storedObject('failure-screenshot', cloneFailureResult.screenshot),
      [],
      null,
    )
    const cloneFailureAnalytics = await database.claimAnalytics(randomUUID())
    assert.ok(cloneFailureAnalytics)
    await database.completeAnalytics(cloneFailureAnalytics)
    const captureWithFailedClone = await database.getSnapshot(
      cloneFailureCommand.payload.ownerId,
      cloneFailureCommand.aggregateId,
    )
    assert.equal(captureWithFailedClone?.['status'], 'COMPLETED')
    assert.equal(captureWithFailedClone?.['reconstruction_status'], 'FAILED')
    assert.equal(captureWithFailedClone?.['failure_code'], 'CLONE_ARCHIVE_GENERATION_FAILED')

    const gcRaceCommand = commandEnvelope()
    await database.acceptCommand(gcRaceCommand)
    const gcRaceLease = await database.claimJob(randomUUID())
    assert.ok(gcRaceLease)
    const gcRaceResult = captureResult()
    const gcRaceArchive = storedObject('gc-race-archive', Buffer.from('gc-race-zip'))
    const gcRaceManifest = storedObject('gc-race-manifest', Buffer.from('{"schemaVersion":1}'))
    gcRaceResult.reconstruction.archiveBytes = gcRaceArchive.bytes
    await database.stageReconstructionArtifacts(
      gcRaceLease,
      { archive: gcRaceArchive, manifest: gcRaceManifest },
    )
    await database.pool.query(
      "update reconstruction_artifacts set delete_after=created_at+interval '1 millisecond' "
        + 'where reconstruction_job_id=(select id from reconstruction_jobs where capture_job_id=$1)',
      [gcRaceCommand.aggregateId],
    )
    const gcClaim = await database.claimReconstructionArtifactForDeletion()
    assert.ok(gcClaim)
    await database.stageResult(
      gcRaceLease,
      gcRaceResult,
      storedObject('gc-race-html', gcRaceResult.html),
      storedObject('gc-race-screenshot', gcRaceResult.screenshot),
      [],
      { archive: gcRaceArchive, manifest: gcRaceManifest },
    )
    const gcRaceReconstruction = await database.getReconstruction(
      gcRaceCommand.payload.ownerId,
      gcRaceCommand.aggregateId,
    )
    assert.equal(gcRaceReconstruction?.['reconstruction_status'], 'FAILED')
    assert.equal(gcRaceReconstruction?.['failure_code'], 'CLONE_ARTIFACT_STAGE_INCOMPLETE')
  } finally {
    await database.close()
    await admin.query(`drop schema "${schemaName}" cascade`)
    await admin.end()
  }
})

function commandEnvelope(): CaptureCommandEnvelope {
  const captureRequestId = randomUUID()
  return {
    messageId: randomUUID(),
    aggregateType: 'CAPTURE',
    aggregateId: captureRequestId,
    aggregateVersion: 0,
    messageType: 'CAPTURE_REQUESTED',
    contractVersion: 1,
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      captureRequestId,
      ownerId: randomUUID(),
      scanId: randomUUID(),
      pageId: randomUUID(),
      targetUrl: 'https://example.com/',
      viewportWidth: 1365,
      viewportHeight: 768,
      timeoutSeconds: 30,
      maxTotalBytes: 52_428_800,
      maxResourceBytes: 10_485_760,
      maxNetworkRequests: 500,
      maxResourceBodies: 100,
      measurementProfile: 'desktop-lab-v1',
      staticObservation: {
        title: 'Example Domain', description: null, canonicalUrl: null, h1: 'Example Domain',
        links: 1, images: 0, schemaOrgTypes: [], observedAt: new Date().toISOString(),
      },
    },
  }
}

function captureResult(): CaptureResult {
  const unavailable = {
    status: 'UNAVAILABLE' as const,
    value: null,
    unit: 'ms' as const,
    source: 'PLAYWRIGHT_LAB' as const,
    profileVersion: 'desktop-lab-v1',
    unavailableReason: 'NO_ENTRY',
  }
  return {
    finalUrl: 'https://example.com/',
    html: Buffer.from('<html></html>'),
    screenshot: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    rendered: {
      title: 'Example Domain', description: '', canonicalUrl: '', metaRobots: '', h1: ['Example Domain'],
      wordCount: 2, linkCount: 1, imageCount: 0,
      openGraph: { title: '', description: '', imageUrl: '' }, schemaOrgTypes: [],
    },
    diff: {
      staticObservedAt: new Date().toISOString(), renderedObservedAt: new Date().toISOString(),
      titleChanged: false, descriptionChanged: false, canonicalChanged: false, h1Changed: false,
      contentChanged: false, linkCountDelta: 0, imageCountDelta: 0, schemaTypesChanged: false,
    },
    performance: { lcp: unavailable, cls: { ...unavailable, unit: 'score' }, ttfb: unavailable },
    network: [],
    resourceBodies: [],
    browserVersion: 'test-browser',
    observedAt: new Date().toISOString(),
    totalTransferBytes: 1,
    reconstruction: {
      status: 'PUBLISHED',
      engineVersion: 'weblens-1/pagesource-0.1.2@f59ed61',
      discoveredCount: 1,
      packagedCount: 1,
      skippedCount: 0,
      inputBytes: 13,
      archiveBytes: null,
      completenessCode: 'COMPLETE',
      failureCode: null,
      archivePath: null,
      temporaryDirectory: null,
      manifest: null,
    },
  }
}

function storedObject(kind: string, bytes: Buffer): StoredObject {
  return {
    bucket: 'weblens-captures',
    key: `integration/${kind}`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest(),
    contentType: kind.includes('screenshot') ? 'image/jpeg'
      : kind.includes('archive') ? 'application/zip'
        : kind.includes('manifest') ? 'application/json'
          : 'text/html; charset=utf-8',
  }
}
