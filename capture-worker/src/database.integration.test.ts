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
    const htmlObject = storedObject('html', result.html)
    const screenshotObject = storedObject('screenshot', result.screenshot)
    await assert.rejects(
      database.stageResult(firstLease, result, htmlObject, screenshotObject, []),
      /STALE_CAPTURE_LEASE/u,
    )
    await database.stageResult(secondLease, result, htmlObject, screenshotObject, [])

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
  }
}

function storedObject(kind: string, bytes: Buffer): StoredObject {
  return {
    bucket: 'weblens-captures',
    key: `integration/${kind}`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest(),
    contentType: kind === 'screenshot' ? 'image/jpeg' : 'text/html; charset=utf-8',
  }
}
