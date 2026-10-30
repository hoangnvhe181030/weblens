#!/usr/bin/env node
// Admission-only diagnostic. Never connects to a supplied backend or Docker TCP host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertKnownOptions, integerOption, parseCommandLine, stringOption, flag } from './lib/cli.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (name, value) => writeFile(name, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export function parseObservations(log) {
  return log.split(/\r?\n/).filter(line => line.includes('PHASE5_SCAN|')).map(line => {
    const fields = line.match(/PHASE5_SCAN\|[^"\r\n]+/)[0].split('|');
    assert.equal(fields.length, 15, 'Malformed admission observation');
    const values = fields.slice(1, 3).concat(fields.slice(4, 14)).map(Number);
    assert(values.every(value => Number.isFinite(value) && value >= 0), 'Invalid observation number');
    assert(!fields[3] || uuid.test(fields[3]), 'Invalid scan ID');
    assert(uuid.test(fields[14]), 'Probe requires persisted correlation UUID');
    return { index: +fields[1], accountIndex: +fields[2], scanId: fields[3] || null,
      status: +fields[4], durationMs: +fields[5], elapsedMs: +fields[6], errorCode: +fields[7],
      blockedMs: +fields[8], connectingMs: +fields[9], tlsMs: +fields[10], sendingMs: +fields[11],
      waitingMs: +fields[12], receivingMs: +fields[13], correlationId: fields[14] };
  });
}

export function reconcile(entries, observations, database, backendLog) {
  assert.equal(observations.length, entries.length, 'Missing attempts; do not report a successful run');
  assert.equal(new Set(observations.map(row => row.index)).size, entries.length, 'Duplicate attempt');
  assert.equal(new Set(observations.map(row => row.correlationId)).size, entries.length, 'Duplicate correlation');
  const rows = observations.map(row => {
    const entry = entries[row.index];
    assert(entry && entry.correlationId === row.correlationId && entry.accountIndex === row.accountIndex,
      'Observation does not match seed');
    const receipts = database.filter(receipt => receipt.correlationId === row.correlationId);
    const lines = backendLog.split(/\r?\n/).filter(line => line.includes(`correlationId=${row.correlationId}`));
    const enter = lines.filter(line => line.includes('scan_admission_enter '));
    const exit = lines.filter(line => line.includes('scan_admission_exit '));
    const timing = lines.filter(line => line.includes('scan_admission_timing '));
    const committed = receipts.length === 1 && receipts[0].websiteId === entry.websiteId
      && receipts[0].ownerEmail === entry.email && receipts[0].scanStatus === 'QUEUED'
      && receipts[0].outboxStatus === 'PENDING';
    const accepted = row.status === 202 && Boolean(row.scanId);
    const evidenceComplete = enter.length === 1 && exit.length === 1 && timing.length === 1
      && exit[0].includes(`status=${row.status} completed=true`)
      && timing[0].includes('transactionStatus=COMMITTED')
      && timing[0].includes(`scanId=${row.scanId}`);
    return { ...row, accepted, committed, evidenceComplete,
      consistent: accepted && committed && receipts[0].scanId === row.scanId && evidenceComplete,
      diagnosis: accepted && committed && evidenceComplete ? 'ACCEPTED_AND_COMMITTED' : 'UNKNOWN',
      backendEvidence: lines };
  });
  return { requested: entries.length, accepted: rows.filter(row => row.accepted).length,
    committedObserved: rows.filter(row => row.committed).length,
    status0: rows.filter(row => row.status === 0).length,
    unresolved: rows.filter(row => !row.consistent).length, rows };
}

export function elapsedValues(summary) {
  const metric = summary.metrics?.scan_admission_elapsed;
  const values = metric?.values || metric;
  assert(values && ['p(95)', 'p(99)'].every(key => Number.isFinite(values[key])),
    'Missing admission elapsed percentiles; evidence is incomplete');
  return values;
}

export function assertLocalDockerHost(host) {
  assert(!host || /^(npipe:\/\/|unix:\/\/)/.test(host), 'DOCKER_HOST must be a local socket');
}

function run(command, args, { cwd = repo, env = process.env, log, allowed = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let output = '';
    const stream = log ? createWriteStream(log, { flags: 'wx' }) : null;
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => {
      if (stream) stream.write(chunk); else output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      const done = () => allowed.includes(code) ? resolve({ code, output })
        : reject(new Error(`${path.basename(command)} failed (${code}); inspect the local evidence log`));
      if (stream) stream.end(done); else done();
    });
  });
}

async function sourceHashes(root) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Source symlinks are not supported');
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name); else files.push(name);
    }
  }
  await walk('backend/src');
  files.push('backend/pom.xml', 'tools/load/k6/crawler-submit.js');
  return Promise.all(files.sort().map(async name => ({ path: name.replaceAll('\\', '/'),
    sha256: sha(await readFile(path.join(root, name))) })));
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function main(argv) {
  const { options } = parseCommandLine(['probe', ...argv]);
  assertKnownOptions(options, new Set(['count', 'rounds', 'warm', 'stagger-ms', 'hikari-max', 'help']));
  if (flag(options, 'help')) {
    console.log('Local Java/PostgreSQL/Redis admission-only probe; no crawler, TLS, production or API-report benchmark.\n'
      + 'node tools/load/local-admission-probe.mjs [--count 25] [--rounds 3] [--warm 0|1] [--stagger-ms 0..1000] [--hikari-max 64]\n'
      + 'Creates a hashed source snapshot, runs clean verify, sends one POST/key with 5s timeout; stops at any failed gate.\n'
      + 'Removes only its own temporary containers/data. Keeps evidence/source/build under tmp/load.');
    return;
  }
  const count = integerOption(options, 'count', 25, { minimum: 1, maximum: 150 });
  const rounds = integerOption(options, 'rounds', 3, { minimum: 1, maximum: 3 });
  const hikariMax = integerOption(options, 'hikari-max', 64, { minimum: 1, maximum: 64 });
  const hikariMin = Math.min(16, hikariMax);
  const warm = stringOption(options, 'warm', '0');
  assert(['0', '1'].includes(warm), 'warm must be 0 or 1');
  const stagger = integerOption(options, 'stagger-ms', 0, { minimum: 0, maximum: 1000 });
  assertLocalDockerHost(process.env.DOCKER_HOST);
  const context = JSON.parse((await run('docker', ['context', 'inspect'])).output);
  assert(context.length === 1 && /^(npipe:\/\/|unix:\/\/)/.test(context[0].Endpoints.docker.Host),
    'Only local Docker named-pipe/unix socket contexts are allowed');
  const runId = randomUUID();
  const outputDir = path.join(repo, 'tmp/load', `admission-${runId}`);
  const snapshot = path.join(outputDir, 'source');
  await mkdir(snapshot, { recursive: true });
  const sources = await sourceHashes(repo);
  await cp(path.join(repo, 'backend/src'), path.join(snapshot, 'backend/src'), { recursive: true });
  await cp(path.join(repo, 'backend/pom.xml'), path.join(snapshot, 'backend/pom.xml'));
  await mkdir(path.join(snapshot, 'tools/load/k6'), { recursive: true });
  await cp(path.join(repo, 'tools/load/k6/crawler-submit.js'), path.join(snapshot, 'tools/load/k6/crawler-submit.js'));
  assert.deepEqual(await sourceHashes(snapshot), sources, 'Snapshot/source changed during copy');
  // Do not inherit application credentials/config or JVM injection options from the operator shell.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(WEBLENS_|SPRING_|DB_|SERVER_|MANAGEMENT_|LOGGING_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|MAVEN_OPTS$|MAVEN_ARGS$)/i.test(key)));
  const manifest = { runId, createdAt: new Date().toISOString(), scope: 'LOCAL_ADMISSION_ONLY',
    releaseEligible: false, sourceHead: (await run('git', ['rev-parse', 'HEAD'])).output.trim(),
    dirtySource: Boolean((await run('git', ['status', '--porcelain'])).output.trim()),
    sourceDigest: sha(JSON.stringify(sources)), sources,
    runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    cliSha256: sha(await readFile(path.join(repo, 'tools/load/lib/cli.mjs'))),
    node: process.version, java: (await run('java', ['-version'], { env: cleanEnv })).output.trim(),
    k6: (await run('k6', ['version'])).output.trim(),
    host: { platform: os.platform(), arch: os.arch(), logicalCpus: os.cpus().length, totalMemory: os.totalmem() },
    workload: { count, rounds, warmConnection: warm === '1', staggerMs: stagger, postTimeoutSeconds: 5,
      postsPerKey: 1, authSetup: 'registration and login paced 1.1s, distinct users each round' },
    limitations: ['No Caddy/TLS/crawler/ClickHouse/capture/object storage', 'Same machine generator and target',
      'No matched historical baseline', 'Database grows between rounds', 'No continuous host/DB telemetry'] };
  await json(path.join(outputDir, 'source-manifest.json'), manifest);
  console.log(`Evidence: ${outputDir}\nBuilding hashed source snapshot with clean verify...`);
  const buildCommand = process.platform === 'win32' ? 'cmd.exe' : 'mvn';
  const buildArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'mvn -B clean verify'] : ['-B', 'clean', 'verify'];
  await run(buildCommand, buildArgs, { cwd: path.join(snapshot, 'backend'), env: cleanEnv,
    log: path.join(outputDir, 'build.log') });
  await run('pwsh', ['-NoProfile', '-File', path.join(repo, 'tools/verify-backend-integration.ps1'),
    '-Reports', path.join(snapshot, 'backend/target/failsafe-reports')], { env: cleanEnv });
  const jar = path.join(snapshot, 'backend/target/weblens-backend-0.0.1-SNAPSHOT.jar');
  assert.deepEqual(await sourceHashes(snapshot), sources, 'Build modified input source');
  const containers = [];
  let backend;
  let backendStream;
  const results = [];
  const runtime = { ...manifest, jarSha256: sha(await readFile(jar)), build: 'clean verify + critical IT evidence gate',
    config: { dispatcherEnabled: false, admissionLogLevel: 'DEBUG', hikariMax, hikariMin,
      redisTimeout: '1s', javaHeap: '256m..768m', postgresMemory: '512m', redisMemory: '128m' }, images: [] };
  let outcome = 'FAILED';
  try {
    async function container(image, port, extra, env = cleanEnv) {
      const id = (await run('docker', ['run', '-d', '--label', `weblens.admission-probe=${runId}`,
        '-p', `127.0.0.1::${port}`, ...extra, image], { env })).output.trim();
      assert(/^[0-9a-f]{64}$/.test(id), 'Invalid created container ID');
      containers.push(id);
      const details = JSON.parse((await run('docker', ['inspect', id])).output)[0];
      const binding = details.NetworkSettings.Ports[`${port}/tcp`][0];
      assert.equal(binding.HostIp, '127.0.0.1');
      runtime.images.push({ image, imageId: details.Image, containerId: id, port: +binding.HostPort });
      return { id, port: +binding.HostPort };
    }
    const password = randomBytes(24).toString('hex');
    const pg = await container('postgres:17.6-alpine', 5432, ['--memory', '512m', '-e', 'POSTGRES_USER=weblens_probe',
      '-e', 'POSTGRES_DB=weblens_probe', '-e', 'POSTGRES_PASSWORD'], { ...cleanEnv, POSTGRES_PASSWORD: password });
    const redis = await container('redis:7.4-alpine', 6379, ['--memory', '128m']);
    for (let tries = 0; ; tries++) {
      try { await run('docker', ['exec', pg.id, 'pg_isready', '-U', 'weblens_probe']); break; }
      catch { if (tries >= 30) throw new Error('Probe PostgreSQL did not become ready'); await delay(1000); }
    }
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    runtime.config.port = port;
    await json(path.join(outputDir, 'runtime-manifest.json'), runtime);
    const backendLog = path.join(outputDir, 'backend.log');
    backendStream = createWriteStream(backendLog, { flags: 'wx' });
    backend = spawn('java', ['-Xms256m', '-Xmx768m', '-jar', jar], { windowsHide: true, env: { ...cleanEnv,
      DB_URL: `jdbc:postgresql://127.0.0.1:${pg.port}/weblens_probe`, DB_USERNAME: 'weblens_probe', DB_PASSWORD: password,
      WEBLENS_REDIS_PORT: String(redis.port), WEBLENS_JWT_SECRET: randomBytes(48).toString('hex'),
      WEBLENS_SERVICE_TOKEN: randomBytes(32).toString('hex'), SERVER_ADDRESS: '127.0.0.1', SERVER_PORT: String(port),
      WEBLENS_CRAWLER_DISPATCH_ENABLED: 'false', WEBLENS_CAPTURE_DISPATCH_ENABLED: 'false',
      WEBLENS_HIKARI_MAX_POOL_SIZE: String(hikariMax), WEBLENS_HIKARI_MIN_IDLE: String(hikariMin),
      WEBLENS_ADMISSION_LOG_LEVEL: 'DEBUG' } });
    backend.stdout.pipe(backendStream, { end: false }); backend.stderr.pipe(backendStream, { end: false });
    backend.on('error', () => {});
    for (let tries = 0; ; tries++) {
      assert(backend.exitCode === null, 'Backend exited during startup');
      try {
        const health = await fetch(`${base}/actuator/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
        if (health.ok && (await health.json()).status === 'UP') break;
      } catch { /* bounded startup retry, never retries admission */ }
      if (tries >= 90) throw new Error('Backend did not become healthy');
      await delay(1000);
    }
    async function post(route, body, token) {
      const response = await fetch(`${base}${route}`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert(response.ok, `Seed ${route} failed: HTTP ${response.status}`);
      return response.json();
    }
    for (let round = 1; round <= rounds; round++) {
      console.log(`Round ${round}/${rounds}: seed ${count} distinct users/websites, then paced login and admission.`);
      const levelId = randomUUID();
      const phasePassword = randomBytes(24).toString('hex');
      const entries = [];
      for (let index = 0; index < count; index++) {
        await delay(1100);
        const email = `probe-${levelId}-${index}@example.test`;
        const auth = await post('/api/v1/auth/registrations', { email, password: phasePassword, displayName: 'Probe owner' });
        const website = await post('/api/v1/websites', { name: 'Admission fixture',
          url: `https://admission.invalid/${levelId}/${index}` }, auth.accessToken);
        entries.push({ index, accountIndex: index, email, websiteId: website.id, correlationId: randomUUID() });
      }
      const seedFile = path.join(outputDir, `seed-${round}.json`);
      await json(seedFile, { entries });
      const summaryFile = path.join(outputDir, `k6-summary-${round}.json`);
      const logFile = path.join(outputDir, `k6-${round}.log`);
      const k6 = await run('k6', ['run', '--summary-trend-stats', 'avg,min,med,max,p(90),p(95),p(99)', '--summary-export', summaryFile,
        path.join(snapshot, 'tools/load/k6/crawler-submit.js')], { log: logFile, env: { ...cleanEnv,
          WEBLENS_BASE_URL: base, WEBLENS_SCAN_COUNT: String(count), WEBLENS_ACK_HIGH_LOAD: '1',
          WEBLENS_PHASE5_SEED_FILE: seedFile, WEBLENS_PHASE5_PASSWORD: phasePassword, WEBLENS_PHASE5_LEVEL_ID: levelId,
          WEBLENS_ADMISSION_WARM_CONNECTION: warm, WEBLENS_ADMISSION_STAGGER_MS: String(stagger) }, allowed: [0, 99] });
      const observations = parseObservations(await readFile(logFile, 'utf8'));
      const ids = entries.map(entry => `'${entry.correlationId}'`).join(',');
      const database = JSON.parse((await run('docker', ['exec', '-e', 'PGOPTIONS=-c statement_timeout=5000', pg.id, 'psql', '-X', '-U', 'weblens_probe',
        '-d', 'weblens_probe', '-v', 'ON_ERROR_STOP=1', '-Atc', `SELECT coalesce(json_agg(row_to_json(r)), '[]'::json) FROM (
          SELECT o.correlation_id AS "correlationId", s.id AS "scanId", s.website_id AS "websiteId",
          u.email AS "ownerEmail", s.status AS "scanStatus", o.status AS "outboxStatus"
          FROM outbox_events o JOIN scans s ON s.id=o.aggregate_id JOIN users u ON u.id=s.requested_by_user_id
          WHERE o.event_type='SCAN_REQUESTED' AND o.correlation_id IN (${ids})
        ) r;`])).output.trim());
      await delay(100);
      const reconciliation = reconcile(entries, observations, database, await readFile(backendLog, 'utf8'));
      const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
      const result = { round, levelId, k6Exit: k6.code, ...reconciliation,
        elapsed: elapsedValues(summary), httpDuration: summary.metrics.scan_admission_duration?.values || summary.metrics.scan_admission_duration,
        pass: k6.code === 0 && reconciliation.unresolved === 0 };
      await json(path.join(outputDir, `result-${round}.json`), result);
      results.push(result);
      console.log(`Round ${round}: accepted=${result.accepted}/${count}, committed=${result.committedObserved}, unresolved=${result.unresolved}, elapsed p95=${result.elapsed['p(95)']}ms, pass=${result.pass}`);
      assert(result.pass, 'Admission gate failed; stopped without replay or increased timeout');
    }
    outcome = 'PASS';
  } finally {
    if (backend) {
      const stopped = new Promise(resolve => backend.once('close', resolve));
      if (backend.exitCode === null) backend.kill();
      if (backend.exitCode === null) await Promise.race([stopped, delay(10000)]);
      if (backend.exitCode === null) { backend.kill('SIGKILL'); await stopped; }
      await new Promise(resolve => backendStream.end(resolve));
    }
    const cleanup = [];
    for (const id of containers.reverse()) {
      try {
        const owner = JSON.parse((await run('docker', ['inspect', id])).output)[0].Config.Labels['weblens.admission-probe'];
        assert.equal(owner, runId, 'Container ownership mismatch; refusing removal');
        await run('docker', ['rm', '-f', '-v', id]);
        cleanup.push({ id, removed: true });
      } catch { cleanup.push({ id, removed: false }); }
    }
    await json(path.join(outputDir, 'final.json'), { outcome, results, cleanup, finishedAt: new Date().toISOString() });
    assert(cleanup.every(item => item.removed), 'Temporary container cleanup incomplete; inspect final.json');
    console.log(`Outcome ${outcome}; owned ephemeral database/Redis removed. Evidence retained: ${outputDir}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
