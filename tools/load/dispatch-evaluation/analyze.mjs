import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const json = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const jsonl = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(JSON.parse);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function index(rows, key) {
  const result = new Map(rows.map((row) => [row[key], row]));
  assert.equal(result.size, rows.length, `Duplicate ${key}`);
  return result;
}

function statistics(values) {
  assert.ok(values.length > 0, 'No timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.every(Number.isFinite), 'Invalid timestamp');
  const quantile = (p) => {
    const position = (sorted.length - 1) * p;
    const left = Math.floor(position);
    return sorted[left] + (sorted[Math.ceil(position)] - sorted[left]) * (position - left);
  };
  return { count: sorted.length, minMs: sorted[0], medianMs: quantile(0.5), p95Ms: quantile(0.95), maxMs: sorted.at(-1) };
}

function reconcile(commands, inbox, scans, executions) {
  const messages = index(inbox, 'message_id');
  const control = index(scans, 'id');
  const remote = index(executions, 'scan_id');
  assert.equal(index(commands, 'message_id').size, messages.size, 'Inbox count mismatch');
  assert.equal(commands.length, control.size, 'Scan count mismatch');
  assert.equal(commands.length, remote.size, 'Execution count mismatch');
  const timings = { controlCreatedToDelivered: [], controlCreatedToCrawlerAcceptanceTimestamp: [], controlCreatedToInboxTimestamp: [], crawlerAcceptedToStarted: [] };
  for (const command of commands) {
    const receipt = messages.get(command.message_id);
    const scan = control.get(command.aggregate_id);
    const execution = remote.get(command.aggregate_id);
    assert.ok(receipt && scan && execution, 'Missing command identity');
    assert.equal(command.event_type, 'SCAN_REQUESTED');
    assert.equal(receipt.message_type, command.event_type);
    assert.equal(command.aggregate_id, receipt.aggregate_id);
    assert.equal(command.aggregate_version, receipt.aggregate_version);
    assert.equal(scan.requested_by_user_id, execution.owner_id);
    assert.equal(scan.website_id, execution.website_id);
    assert.equal(command.status, 'DELIVERED');
    assert.equal(receipt.outcome, 'APPLIED');
    assert.equal(command.delivery_attempts, 1);
    assert.equal(command.last_error_code, null);
    assert.equal(scan.status, execution.status);
    const difference = (a, b) => Date.parse(b) - Date.parse(a);
    timings.controlCreatedToDelivered.push(difference(command.created_at, command.delivered_at));
    timings.controlCreatedToCrawlerAcceptanceTimestamp.push(difference(command.created_at, execution.accepted_at));
    timings.controlCreatedToInboxTimestamp.push(difference(command.created_at, receipt.received_at));
    timings.crawlerAcceptedToStarted.push(difference(execution.accepted_at, execution.started_at));
  }
  return Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, statistics(values)]));
}

if (process.argv[2] === '--transport') {
  const report = json(process.argv[3]);
  assert.equal(report.type, 'LOCAL_SYNTHETIC_TRANSPORT_ONLY');
  assert.equal(report.productionChanged, false);
  assert.equal(report.realPostgres, false);
  assert.equal(report.realCrawler, false);
  assert.equal(report.results.length, 27);
  const groups = new Map();
  for (const sample of report.results) {
    assert.equal(sample.accepted, sample.commands);
    assert.equal(sample.errors, 0);
    assert.ok(['http-1', 'http-4', 'rabbit-4'].includes(sample.mode));
    assert.ok([150, 300, 500].includes(sample.commands));
    assert.ok([1, 2, 3].includes(sample.round));
    const key = `${sample.commands}/${sample.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  assert.equal(groups.size, 9);
  const comparisons = [...groups].map(([group, samples]) => {
    assert.deepEqual(new Set(samples.map((sample) => sample.round)), new Set([1, 2, 3]));
    return {
      group, samples: samples.length,
      acceptanceP95MsAcrossRounds: statistics(samples.map((sample) => sample.acceptanceP95Ms)),
      allAcceptedMsAcrossRounds: statistics(samples.map((sample) => sample.allAcceptedMs)),
      senderDoneMsAcrossRounds: statistics(samples.map((sample) => sample.senderDoneMs))
    };
  });
  const result = { type: report.type, brokerVersion: report.brokerVersion, workMs: report.workMs,
    inputSha256: digest(process.argv[3]), comparisons,
    limitations: ['Synthetic transport experiment with simulated inbox and 20ms processing delay.',
      'No PostgreSQL, actual command handler, outbox poll, scan/page workload, public TLS or 500 API users.',
      'senderDoneMs for RabbitMQ is broker confirmation, not consumer acceptance.',
      'No production capacity or crawl throughput conclusion.'] };
  const output = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[4]) writeFileSync(process.argv[4], output, 'utf8');
  console.log(output);
} else if (process.argv[2] === '--self-test') {
  assert.equal(statistics([0, 10, 20]).p95Ms, 19);
  assert.throws(() => index([{ id: 'a' }, { id: 'a' }], 'id'));
  assert.throws(() => statistics([NaN]));
  const command = { message_id: 'm', aggregate_id: 's', aggregate_version: 0, event_type: 'SCAN_REQUESTED', status: 'DELIVERED', delivery_attempts: 1, last_error_code: null, created_at: '2026-10-03T00:00:00Z', delivered_at: '2026-10-03T00:00:01Z' };
  const receipt = { ...command, message_type: 'SCAN_REQUESTED', outcome: 'APPLIED', received_at: command.delivered_at };
  const scan = { id: 's', requested_by_user_id: 'owner', website_id: 'website', status: 'COMPLETED' };
  const execution = { scan_id: 's', owner_id: 'owner', website_id: 'website', status: 'COMPLETED', accepted_at: command.delivered_at, started_at: '2026-10-03T00:00:02Z' };
  assert.equal(reconcile([command], [receipt], [scan], [execution]).controlCreatedToDelivered.p95Ms, 1000);
  assert.throws(() => reconcile([command], [{ ...receipt, aggregate_version: 2 }], [scan], [execution]));
  assert.throws(() => reconcile([command], [receipt], [scan], [{ ...execution, owner_id: 'other' }]));
  console.log('Dispatch evidence self-test PASS');
} else {
  const directory = process.argv[2];
  assert.ok(directory, 'Usage: node analyze.mjs <runtime150-run-directory> [output.json]');
  const files = ['dispatch-db-proof.json', 'terminal-db-proof-staged.jsonl', 'crawler-terminal-proof.jsonl'];
  const proof = json(join(directory, files[0]));
  assert.equal(proof.scope, 'worker64-150-runtime-v1-20261003T062608Z');
  assert.equal(proof.readOnly, true);
  const scans = jsonl(join(directory, files[1])).flatMap((row) => row.control?.scans ?? []);
  const executions = jsonl(join(directory, files[2])).flatMap((row) => row.crawler?.executions ?? []);
  const observations = json(join(directory, '150-scans/submission-observations.json'));
  const admitted = observations.filter((row) => row.status === 202);
  const timeouts = observations.filter((row) => row.status === 0 && row.transportErrorCode === 1050);
  assert.equal(observations.length, 150);
  assert.equal(admitted.length, proof.control.commands.length);
  assert.equal(timeouts.length, 4);
  assert.deepEqual(new Set(admitted.map((row) => row.scanId)), new Set(scans.map((row) => row.id)));
  const result = {
    scope: proof.scope, readAtUtc: proof.timestampUtc,
    acknowledgedCommands: proof.control.commands.length,
    requestedAdmissions: observations.length, admissionTimeouts: timeouts.length,
    submissionSummaryIncludedInHashes: true,
    timings: reconcile(proof.control.commands, proof.crawler.inbox, scans, executions),
    sourceHashes: Object.fromEntries([...files, '150-scans/submission-summary.json', '150-scans/submission-observations.json'].map((name) => [name, digest(join(directory, name))])),
    limitations: [
      '146 accepted scans only; four HTTP admission failures remain failures.',
      'Cross-service timestamps assume clocks are comparable; no synchronization bound was measured.',
      'accepted_at is captured before transaction commit, not durable acknowledgment time.',
      'received_at and processed_at are written from the same timestamp near inbox insert; they do not measure handler duration.',
      'No claim-start timestamp or request-duration trace: outbox wait, HTTP and database time cannot be separated.',
      'This is command handoff evidence, not a 500-user capacity test.'
    ]
  };
  const output = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[3]) writeFileSync(process.argv[3], output, 'utf8');
  console.log(output);
}
