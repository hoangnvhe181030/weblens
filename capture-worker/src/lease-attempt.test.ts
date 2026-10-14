import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { test } from 'node:test'
import { LeaseAttempt } from './lease-attempt.js'

test('healthy heartbeats cannot renew an attempt beyond its deadline', async () => {
  let renewals = 0
  const attempt = new LeaseAttempt(40, async () => { renewals++; return true }, 5)
  try {
    await once(attempt.signal, 'abort')
    assert.throws(() => attempt.check(), /WORKER_ATTEMPT_TIMEOUT/u)
    const stoppedAt = renewals
    await delay(20)
    assert.equal(renewals, stoppedAt)
    assert.ok(renewals > 0)
  } finally { attempt.close() }
})

test('lost or failed heartbeat aborts I/O and a slow heartbeat never overlaps', async () => {
  for (const fails of [false, true]) {
    let calls = 0
    const attempt = new LeaseAttempt(5000, async () => {
      calls++
      await delay(25)
      if (fails) throw new Error('DATABASE_DOWN')
      return false
    }, 5)
    try {
      await once(attempt.signal, 'abort')
      assert.equal(calls, 1)
      assert.throws(() => attempt.check(), fails ? /WORKER_HEARTBEAT_FAILED/u : /STALE_WORKER_LEASE/u)
    } finally { attempt.close() }
  }
})
