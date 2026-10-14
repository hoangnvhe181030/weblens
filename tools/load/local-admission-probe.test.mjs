import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseObservations, reconcile, elapsedValues, assertLocalDockerHost, main } from './local-admission-probe.mjs';

const id = '018f0f00-0000-7000-8000-000000000002';
const correlationId = '018f0f00-0000-7000-8000-000000000003';
const entry = { index: 0, accountIndex: 0, email: 'owner@example.test', websiteId: id, correlationId };
const receipt = { correlationId, scanId: id, websiteId: id, ownerEmail: entry.email,
  scanStatus: 'QUEUED', outboxStatus: 'PENDING' };
const logs = `scan_admission_enter correlationId=${correlationId}\n`
  + `scan_admission_exit correlationId=${correlationId} status=202 completed=true elapsedMs=100\n`
  + `scan_admission_timing correlationId=${correlationId} scanId=${id} transactionStatus=COMMITTED`;
const response = `time=x level=info msg="PHASE5_SCAN|0|0|${id}|202|100|103|0|3|2|0|1|98|1|${correlationId}" source=console`;

test('successful response requires matching durable scan/outbox and complete logs', () => {
  const rows = parseObservations(response);
  assert.equal(rows[0].elapsedMs, 103);
  assert.equal(reconcile([entry], rows, [receipt], logs).unresolved, 0);
  for (const receipts of [[], [receipt, receipt], [{ ...receipt, ownerEmail: 'other@example.test' }],
    [{ ...receipt, websiteId: correlationId }], [{ ...receipt, scanId: correlationId }]]) {
    assert.equal(reconcile([entry], rows, receipts, logs).unresolved, 1);
  }
  assert.equal(reconcile([entry], rows, [receipt], '').unresolved, 1);
});

test('status zero retains elapsed, does not invent cause or equate commit with acceptance', () => {
  const rows = parseObservations(`PHASE5_SCAN|0|0||0|0|5004|1050|0|1031|0|0|0|0|${correlationId}`);
  const result = reconcile([entry], rows, [receipt], logs);
  assert.equal(result.status0, 1);
  assert.equal(result.accepted, 0);
  assert.equal(result.committedObserved, 1);
  assert.equal(result.rows[0].elapsedMs, 5004);
  assert.equal(result.rows[0].diagnosis, 'UNKNOWN');
});

test('missing, duplicate and mismatched attempts cannot pass', () => {
  const rows = parseObservations(response);
  assert.throws(() => reconcile([entry], [], [], ''), /Missing attempts/);
  assert.throws(() => reconcile([entry, entry], [rows[0], rows[0]], [], ''), /Duplicate attempt/);
  assert.throws(() => reconcile([{ ...entry, accountIndex: 7 }], rows, [], ''), /does not match/);
  assert.throws(() => parseObservations(response.replace('|103|', '|NaN|')), /Invalid observation/);
  assert.throws(() => parseObservations('PHASE5_SCAN|0'), /Malformed/);
});

test('unknown target/build bypass flags and invalid workloads fail before spawning', async () => {
  await assert.rejects(main(['--base-url', 'https://production.example']), /not|hỗ trợ/);
  await assert.rejects(main(['--skip-build', '1']), /not|hỗ trợ/);
  await assert.rejects(main(['--count', '151']), /150/);
  await assert.rejects(main(['--warm', '2']), /warm/);
  await assert.rejects(main(['--hikari-max', '0']), /hikari-max/);
  await assert.rejects(main(['--hikari-max', '65']), /hikari-max/);
});

test('k6 flat and wrapped summaries retain p95/p99; missing percentiles cannot pass', () => {
  const values = { 'p(95)': 304, 'p(99)': 305 };
  assert.deepEqual(elapsedValues({ metrics: { scan_admission_elapsed: values } }), values);
  assert.deepEqual(elapsedValues({ metrics: { scan_admission_elapsed: { values } } }), values);
  assert.throws(() => elapsedValues({ metrics: { scan_admission_elapsed: { 'p(95)': 304 } } }), /incomplete/);
  assert.throws(() => elapsedValues({}), /incomplete/);
});

test('Docker environment override cannot target a TCP/SSH daemon', () => {
  for (const host of ['tcp://127.0.0.1:2375', 'ssh://operator@host', 'https://host']) {
    assert.throws(() => assertLocalDockerHost(host), /local socket/);
  }
  for (const host of [undefined, 'npipe:////./pipe/docker_engine', 'unix:///var/run/docker.sock']) {
    assert.doesNotThrow(() => assertLocalDockerHost(host));
  }
});
