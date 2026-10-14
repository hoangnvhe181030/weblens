import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCoverage, assertSelectivePlan, baselineReadTimeout, indexSteps, main, profileFor, restorePageSQL, seedEvents, seedPages, summarize, timedNotice } from './recovery-index-probe.mjs';

test('baseline timeout remains unknown; candidate failure or another SQLSTATE cannot be suppressed', () => {
  assert.deepEqual(baselineReadTimeout('before', 3, 'ERROR: 57014: canceling statement'),
    { outcome: 'TIMEOUT', executionMs: null, sqlstate: '57014', timeoutMs: 2000 });
  assert.equal(baselineReadTimeout('after', 0, ''), null);
  assert.throws(() => baselineReadTimeout('after', 3, 'ERROR: 57014'));
  assert.throws(() => baselineReadTimeout('before', 3, 'ERROR: 55P03'));
  assert.throws(() => baselineReadTimeout('before', 2, 'server starting'));
});

test('bounded setup batches retain absolute IDs and create executions only once', () => {
  assert(seedPages('2026-09-01', 516071, 1, 50000).includes('INSERT INTO crawl_executions'));
  const last = seedPages('2026-09-01', 516071, 500001, 50000);
  assert(!last.includes('INSERT INTO crawl_executions'));
  assert(last.includes('generate_series(500001,516071)'));
  assert(last.includes("((n-1)/1000)"));
  assert(seedEvents(3499939, 3400001, 100000).includes('generate_series(3400001,3499939)'));
  assert.throws(() => seedEvents(10, 0, 1));
  assert.throws(() => seedPages('2026-09-01', 10, 11, 1));
});

test('future partition fixture completion cannot precede discovery', () => {
  const sql = restorePageSQL("retention_month='2027-04-01'");
  assert(sql.includes('completed_at=greatest(discovered_at,clock_timestamp())'));
  assert(sql.includes("WHERE retention_month='2027-04-01'"));
});

test('profiles bound synthetic workload; unknown or unsafe CLI flags fail before creating resources', async () => {
  assert.equal(profileFor('representative').events, 3499939);
  assert.equal(profileFor('smoke').september, 15000);
  assert.throws(() => profileFor('production'));
  for (const argv of [['--target', 'https://jobnext.top'], ['--profile', 'production'], ['--skip-guards', '1']])
    await assert.rejects(main(argv));
});

test('concurrent builds remain separate statements; parent ONLY precedes leaf attachment', () => {
  const steps = indexSteps(['scan_pages_default', 'scan_pages_2026_09']);
  assert.equal(steps.length, 6);
  assert(steps[0].startsWith('CREATE INDEX CONCURRENTLY'));
  assert(steps[1].includes('ON ONLY scan_pages'));
  assert(steps[2].includes('CONCURRENTLY'));
  assert(steps[3].includes('ATTACH PARTITION'));
  assert(steps.every(step => !/BEGIN|IF NOT EXISTS|CASCADE/.test(step)));
  assert.throws(() => indexSteps(['scan_pages; DROP TABLE users']));
  assert.throws(() => indexSteps(['scan_pages_default', 'scan_pages_default']));
});

function coverage() {
  const base = { valid: true, ready: true, live: true, unique: false, method: 'btree', attributeCount: 1,
    columns: 'id', predicate: "(status = 'PERSISTING'::text)" };
  return [{ ...base, kind: 'parent', table: 'scan_pages' },
    { ...base, kind: 'leaf', table: 'scan_pages_default', parent: 'ix_scan_pages_persisting_recovery' },
    { ...base, kind: 'event', table: 'outbox_events', columns: 'message_id', predicate: "(status = 'DEAD'::text)" }];
}

test('coverage refuses missing/default/future partitions, invalid flags or altered definitions', () => {
  assertCoverage(coverage(), ['scan_pages_default']);
  for (const change of [{ valid: false }, { ready: false }, { live: false }, { unique: true },
    { method: 'hash' }, { columns: 'status' }, { predicate: "status='QUEUED'" }, { attributeCount: 2 }, { parent: null }]) {
    const rows = coverage(); rows[1] = { ...rows[1], ...change };
    assert.throws(() => assertCoverage(rows, ['scan_pages_default']));
  }
  assert.throws(() => assertCoverage(coverage(), ['scan_pages_default', 'scan_pages_2027_04']));
});

test('plan validation cannot pass an execution/status index or skip a partition; empty leaves may use Seq Scan', () => {
  const leaf = { 'Node Type': 'Index Only Scan', 'Relation Name': 'scan_pages_2026_09',
    'Index Name': 'scan_pages_2026_09_persisting_recovery' };
  const empty = { 'Node Type': 'Seq Scan', 'Relation Name': 'scan_pages_default' };
  const plan = { Plan: { Plans: [leaf, empty] } };
  assertSelectivePlan(plan, 'pages', ['scan_pages_2026_09', 'scan_pages_default'], ['scan_pages_2026_09']);
  assert.throws(() => assertSelectivePlan(plan, 'pages', ['scan_pages_2026_09']));
  assert.throws(() => assertSelectivePlan({ Plan: { ...leaf, 'Index Name': 'ix_execution_status' } }, 'pages', ['scan_pages_2026_09']));
  assert.throws(() => assertSelectivePlan({ Plan: empty }, 'pages', ['scan_pages_default']));
});

test('write evidence requires server timing and WAL, not client Docker startup time', () => {
  assert.deepEqual(timedNotice('NOTICE: 00000: RECOVERY_WRITE|{"elapsedMs":2.3,"walBytes":128,"rows":1000}\nCONTEXT: test'),
    { elapsedMs: 2.3, walBytes: 128, rows: 1000 });
  assert.throws(() => timedNotice('ERROR: 57014'));
  assert.throws(() => timedNotice('RECOVERY_WRITE|{"elapsedMs":-1,"walBytes":0,"rows":1}'));
});

test('summary retains sample size, extremes and rejects missing or non-finite evidence', () => {
  assert.deepEqual(summarize([3, 1, 2]), { samples: 3, median: 2, p95: 3, max: 3 });
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([NaN]));
});
