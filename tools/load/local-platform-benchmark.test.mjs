import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixturePage, zipEntries, summarizeAdmissionTimings, admissionsConsistent, summarizeCpuQuota, main } from './local-platform-benchmark.mjs';

const correlationId = '018f0f00-0000-7000-8000-000000000001';
const scanId = '018f0f00-0000-7000-8000-000000000002';
const attempt = { correlationId, scanId, status: 202, elapsedMs: 100 };
const timingLog = `scan_admission_enter correlationId=${correlationId}\n`
  + `scan_admission_exit correlationId=${correlationId} status=202 completed=true elapsedMs=90\n`
  + `scan_admission_timing correlationId=${correlationId} scanId=${scanId} outcome=NEW_SCAN transactionStatus=COMMITTED bodyMs=30 completionAfterBodyMs=5 stagesMs={user_lock=10, save_and_flush=20}`;

const cpuSnapshot = (usage, periods, throttled, time, quota = '200000 100000') =>
  `${quota}\nusage_usec ${usage}\nuser_usec 100\nsystem_usec 50\nnr_periods ${periods}\nnr_throttled ${throttled}\nthrottled_usec ${time}\n`;

test('CPU quota diagnostics use monotonic counter deltas, not sampled CPU percent or API latency', () => {
  const result = summarizeCpuQuota(cpuSnapshot(1000, 10, 2, 500), cpuSnapshot(101000, 30, 7, 2500));
  assert.equal(result.quotaCpus, 2);
  assert.deepEqual(result.delta, { usage_usec: 100000, nr_periods: 20, nr_throttled: 5, throttled_usec: 2000 });
  assert.equal(result.throttledPeriodFraction, 0.25);
  assert.equal(result.throttledMs, 2);
  assert.equal(summarizeCpuQuota(cpuSnapshot(0, 0, 0, 0, 'max 100000'),
    cpuSnapshot(0, 0, 0, 0, 'max 100000')).throttledPeriodFraction, null);
});

test('missing, invalid, reset or changed-quota CPU counters cannot become diagnostics', () => {
  const before = cpuSnapshot(1000, 10, 2, 500);
  for (const after of ['', before.replace('usage_usec 1000', 'usage_usec NaN'),
    before + 'nr_periods 11\n', before.replace('throttled_usec 500\n', ''),
    cpuSnapshot(999, 11, 2, 500), cpuSnapshot(1001, 11, 2, 500, '100000 100000'),
    cpuSnapshot(1001, 11, 12, 500), cpuSnapshot(1001, 11, 2, 500, '0 100000')]) {
    assert.throws(() => summarizeCpuQuota(before, after));
  }
});

test('admission gate requires a one-to-one seed, response and durable receipt mapping', () => {
  const secondCorrelation = '018f0f00-0000-7000-8000-000000000003';
  const secondScan = '018f0f00-0000-7000-8000-000000000004';
  const secondWebsite = '018f0f00-0000-7000-8000-000000000005';
  const entries = [{ accountIndex: 25, correlationId, websiteId: scanId },
    { accountIndex: 26, correlationId: secondCorrelation, websiteId: secondWebsite }];
  const observations = [{ ...attempt, index: 0, accountIndex: 25 },
    { ...attempt, index: 1, accountIndex: 26, correlationId: secondCorrelation, scanId: secondScan }];
  const receipts = observations.map(o => ({ correlationId: o.correlationId, scanId: o.scanId,
    websiteId: entries[o.index].websiteId }));
  assert.equal(admissionsConsistent(entries, observations.slice().reverse(), receipts.slice().reverse()), true);
  for (const changed of [[observations[0], observations[0]], observations.slice(0, 1),
    [observations[0], { ...observations[1], accountIndex: 25 }],
    [observations[0], { ...observations[1], correlationId }],
    [observations[0], { ...observations[1], index: 2 }],
    [observations[0], { ...observations[1], scanId: '' }],
    [observations[0], { ...observations[1], status: 0 }]]) {
    assert.equal(admissionsConsistent(entries, changed, receipts), false);
  }
  for (const changed of [[], [receipts[0], receipts[0]], [...receipts, receipts[0]],
    [receipts[0], { ...receipts[1], websiteId: scanId }],
    [receipts[0], { ...receipts[1], scanId }]]) {
    assert.equal(admissionsConsistent(entries, observations, changed), false);
  }
  assert.equal(admissionsConsistent([], [], []), false);
  assert.equal(admissionsConsistent([entries[0], entries[0]], observations, receipts), false);
});

test('admission timing joins exact identity and separates service, filter and elapsed residuals', () => {
  const result = summarizeAdmissionTimings([attempt], timingLog + '\ncredential=do-not-export');
  assert.equal(result.complete, true);
  assert.equal(result.matched, 1);
  assert.equal(result.committedObserved, 1);
  assert.equal(result.timingsMs.withinFilterOutsideServiceMs.mean, 55);
  assert.equal(result.timingsMs.outsideFilterResidualMs.mean, 10);
  assert.equal(result.stagesMs.user_lock.mean, 10);
  assert.doesNotMatch(JSON.stringify(result), /do-not-export|credential/);
  // Rounded client clocks may produce a small negative residual; never clamp it.
  assert.equal(summarizeAdmissionTimings([{ ...attempt, elapsedMs: 89 }], timingLog)
    .timingsMs.outsideFilterResidualMs.mean, -1);
});

test('missing, duplicate, malformed or mismatched timing cannot become complete evidence', () => {
  for (const log of ['', timingLog + '\n' + timingLog, timingLog.replace(`scanId=${scanId}`, `scanId=${correlationId}`),
    timingLog.replace('bodyMs=30', 'bodyMs=NaN'), timingLog.replace('status=202 completed', 'status=500 completed'),
    timingLog.replace('stagesMs={user_lock=10', 'stagesMs={password=10'),
    timingLog.replace('save_and_flush=20', 'user_lock=20'), timingLog.replace('bodyMs=30', 'bodyMs=30 bodyMs=30'),
    timingLog.replace('bodyMs=30', 'bodyMs=40')]) {
    const result = summarizeAdmissionTimings([attempt], log);
    assert.equal(result.complete, false);
    assert.equal(result.matched, 0);
    assert.equal(result.timingsMs, null);
  }
  assert.throws(() => summarizeAdmissionTimings([attempt, attempt], timingLog), /Duplicate/);
  assert.throws(() => summarizeAdmissionTimings([{ ...attempt, elapsedMs: NaN }], timingLog), /Invalid/);
  assert.equal(summarizeAdmissionTimings([{ ...attempt, scanId: '' }], timingLog).complete, false);
  // A timed-out POST can still have a matching committed service log, not acceptance.
  const timeout = summarizeAdmissionTimings([{ ...attempt, status: 0, scanId: '', elapsedMs: 5000 }], timingLog);
  assert.equal(timeout.complete, false);
  assert.equal(timeout.committedObserved, 1);
  assert.equal(timeout.transportFailures, 1);
  assert.equal(timeout.acceptedResponses, 0);
});

test('fixture contains exactly the declared pages, locale, real resources and natural HTTP errors', () => {
  for (const n of [100, 1000]) {
    const root = fixturePage(new URL(`http://fixture.invalid/vi/s${n}/`));
    const links = [...root.body.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(links).size + 1, n);
    assert.equal(fixturePage(new URL(`http://fixture.invalid/vi/s${n}/missing`)).status, 404);
    assert.equal(fixturePage(new URL(`http://fixture.invalid/vi/s${n}/gone`)).status, 410);
    assert(links.includes(`/en/s${n}/blog`));
    for (const link of links) assert.match(fixturePage(new URL(link, 'http://fixture.invalid')).type, /text\/html/);
    assert.doesNotMatch(fixturePage(new URL(`http://fixture.invalid/en/s${n}/blog`)).body, /<a href=/);
  }
  assert.match(fixturePage(new URL('http://fixture.invalid/shared.js')).body, /dataset.fixture/);
  assert.equal(fixturePage(new URL('http://fixture.invalid/other')).status, 404);
});

function storedZip(name, value = 'fixture') {
  const local = Buffer.alloc(30), central = Buffer.alloc(46), body = Buffer.from(value), filename = Buffer.from(name);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28);
  return Buffer.concat([local, filename, body, central, filename]);
}
test('archive inspection reads real bytes and refuses unsafe, missing or malformed entries', () => {
  assert.equal(zipEntries(storedZip('index.html')).get('index.html').toString(), 'fixture');
  for (const name of ['../file', '/root', 'pages\\file']) assert.throws(() => zipEntries(storedZip(name)), /Unsafe/);
  assert.throws(() => zipEntries(Buffer.from('not zip')), /No ZIP/);
  const malformed = storedZip('index.html'); malformed.writeUInt32LE(0, 0);
  assert.throws(() => zipEntries(malformed));
});
test('runner cannot accept a remote target, omit acknowledgement, or skip guards', async () => {
  for (const args of [[], ['--target', 'https://production.invalid'], ['--skip-health'], ['--fixture', '--acknowledge-high-load'],
    ['--acknowledge-high-load', '--clone-only', '--api-only'], ['--acknowledge-high-load', '--clone-only', '--balanced-mix']]) await assert.rejects(main(args), /Usage/);
});
