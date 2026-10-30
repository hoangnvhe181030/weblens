#!/usr/bin/env node
// Disposable local experiment, never a production target or a capacity claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { assertLocalDockerHost, parseObservations } from './local-admission-probe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = fileURLToPath(import.meta.url);
const hash = b => createHash('sha256').update(b).digest('hex');
const json = (name, data) => writeFile(name, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const fixtureAddress = '11.254.254.10';
const fixtureRoot = n => `http://${fixtureAddress}:9090/vi/s${n}/`;

export function fixturePage(url) {
  if (url.pathname === '/shared.css') return { status: 200, type: 'text/css', body: 'body{color:#123456}main{max-width:60rem}' };
  if (url.pathname === '/shared.js') return { status: 200, type: 'application/javascript', body: 'document.documentElement.dataset.fixture="rendered";' };
  if (url.pathname.startsWith('/leaf/')) return { status: 200, type: 'text/html', body: '<html lang="vi"><body><main>Leaf</main></body></html>' };
  const match = /^\/(vi|en)\/s(100|1000)\/(.*)$/.exec(url.pathname);
  if (!match) return { status: 404, type: 'text/plain', body: 'not_found' };
  const [, locale, count, route] = match;
  const prefix = `/${locale}/s${count}/`;
  const staticRoutes = ['login', 'register', 'forgot-password', 'pricing', 'blog', 'use-cases', 'use-cases/teams', 'missing', 'gone'];
  const blogs = Number(count) - staticRoutes.length - 2; // root + alternate locale
  if (route && !staticRoutes.includes(route) && !/^blog\/post-\d+$/.test(route)) return { status: 404, type: 'text/plain', body: 'not_found' };
  const links = locale === 'en' ? '' : route ? `<a href="${prefix}">Home</a>` : [...staticRoutes,
    ...Array.from({ length: blogs }, (_, i) => `blog/post-${i}`)].map(r => `<a href="${prefix}${r}">${r}</a>`).join('')
    + `<a href="/en/s${count}/blog">English</a>`;
  const status = route === 'missing' ? 404 : route === 'gone' ? 410 : 200;
  const layout = /^(login|register|forgot-password)$/.test(route) ? 'auth' : route.startsWith('blog/post-') ? 'blog-detail' : route.replaceAll('/', '-') || 'home';
  const canonical = `http://${fixtureAddress}:9090${url.pathname}`;
  const body = `<!doctype html><html lang="${locale}"><head><title>Fixture ${route || 'Home'}</title><link rel="canonical" href="${canonical}"><link rel="stylesheet" href="/shared.css"><script src="/shared.js"></script></head><body><main class="${layout}"><h1>${route || 'Home'}</h1><nav>${links}</nav><section><p>${'bounded synthetic content '.repeat(80)}</p></section></main></body></html>`;
  return { status, type: 'text/html; charset=utf-8', body };
}

export function zipEntries(zip) {
  assert(zip.length <= 64 * 1024 * 1024, 'Test archive exceeds analysis bound');
  const result = new Map();
  let total = 0;
  for (let offset = 0; offset + 46 <= zip.length; offset++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const size = zip.readUInt32LE(offset + 20), expected = zip.readUInt32LE(offset + 24);
    const len = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42), method = zip.readUInt16LE(offset + 10);
    const name = zip.subarray(offset + 46, offset + 46 + len).toString('utf8');
    assert(name && !name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..'), 'Unsafe ZIP path');
    assert(!result.has(name), 'Duplicate ZIP path');
    assert([0, 8].includes(method) && expected <= 16 * 1024 * 1024, 'Unsupported or oversized ZIP entry');
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    assert(start + size <= zip.length, 'Truncated ZIP');
    const bytes = zip.subarray(start, start + size);
    const body = method === 8 ? inflateRawSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) : bytes;
    assert.equal(body.length, expected);
    total += body.length;
    assert(total <= 64 * 1024 * 1024, 'ZIP expansion budget exceeded');
    result.set(name, body);
    offset += 45 + len + extra + comment;
  }
  assert(result.size > 0, 'No ZIP entries');
  return result;
}

export function summarizeCpuQuota(before, after) {
  const keys = ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'];
  function parse(value) {
    assert(typeof value === 'string' && value.length <= 4096, 'Invalid CPU snapshot');
    const [quotaLine, ...lines] = value.trim().split(/\r?\n/);
    const quota = /^(max|[1-9]\d*) ([1-9]\d*)$/.exec(quotaLine);
    assert(quota, 'Missing CPU quota');
    const counters = {};
    for (const line of lines) {
      const match = /^(\w+) (\d+)$/.exec(line);
      assert(match && !(match[1] in counters) && Number.isSafeInteger(Number(match[2])), 'Invalid CPU counter');
      counters[match[1]] = Number(match[2]);
    }
    assert(keys.every(k => Number.isSafeInteger(counters[k]))
      && counters.nr_throttled <= counters.nr_periods, 'Missing or inconsistent CPU counters');
    assert(Number.isSafeInteger(Number(quota[2])) && (quota[1] === 'max'
      || Number.isSafeInteger(Number(quota[1]))), 'Invalid CPU quota');
    return { quotaLine, quotaCpus: quota[1] === 'max' ? null : Number(quota[1]) / Number(quota[2]), counters };
  }
  const first = parse(before), last = parse(after);
  assert(first.quotaLine === last.quotaLine, 'CPU quota changed during phase');
  const delta = Object.fromEntries(keys.map(k => [k, last.counters[k] - first.counters[k]]));
  assert(keys.every(k => delta[k] >= 0) && delta.nr_throttled <= delta.nr_periods, 'CPU counters reset or inconsistent');
  return { quotaCpus: first.quotaCpus, delta,
    throttledPeriodFraction: delta.nr_periods ? delta.nr_throttled / delta.nr_periods : null,
    throttledMs: delta.throttled_usec / 1000 };
}

export function admissionsConsistent(entries, observations, durable) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!Array.isArray(entries) || !Array.isArray(observations) || !Array.isArray(durable)
    || !entries.length || observations.length !== entries.length || durable.length !== entries.length) return false;
  for (const [rows, keys] of [[entries, ['correlationId', 'websiteId', 'accountIndex']],
    [observations, ['index', 'correlationId', 'scanId']], [durable, ['correlationId', 'scanId']]]) {
    if (rows.some(row => !row) || keys.some(key => new Set(rows.map(row => row[key])).size !== rows.length)) return false;
  }
  if (!entries.every(e => uuid.test(e.correlationId) && uuid.test(e.websiteId) && Number.isInteger(e.accountIndex))) return false;
  return observations.every(o => {
    const entry = Number.isInteger(o.index) && o.index >= 0 ? entries[o.index] : null;
    if (!entry || o.status !== 202 || !uuid.test(o.scanId) || o.accountIndex !== entry.accountIndex
      || o.correlationId !== entry.correlationId) return false;
    const receipt = durable.find(d => d.correlationId === o.correlationId);
    return receipt?.scanId === o.scanId && receipt.websiteId === entry.websiteId;
  });
}

// Aggregate diagnostic stages only; not SQL time, network time or a durable receipt.
export function summarizeAdmissionTimings(observations, backendLog) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const stageNames = new Set(['body_entry', 'user_lock', 'website_lock', 'target_and_key_validation',
    'idempotency_lookup', 'website_active_check', 'user_quota_check', 'scan_entity',
    'save_and_flush', 'outbox_enqueue', 'response_mapping']);
  assert(Array.isArray(observations) && observations.length <= 150 && typeof backendLog === 'string'
    && Buffer.byteLength(backendLog) <= 64 * 1024 * 1024, 'Invalid diagnostic input');
  const records = new Map();
  for (const observation of observations) {
    assert(uuid.test(observation.correlationId) && Number.isFinite(observation.elapsedMs)
      && observation.elapsedMs >= 0 && Number.isInteger(observation.status)
      && observation.status >= 0 && observation.status <= 599, 'Invalid admission observation');
    assert(!records.has(observation.correlationId), 'Duplicate admission correlation');
    records.set(observation.correlationId, { observation, enter: [], exit: [], timing: [] });
  }
  for (const line of backendLog.split(/\r?\n/)) {
    const match = /\bscan_admission_(enter|exit|timing) correlationId=([0-9a-f-]{36})\b/.exec(line);
    if (match && records.has(match[2])) records.get(match[2])[match[1]].push(line);
  }
  const rows = [], incomplete = [], stageValues = {};
  let committedObserved = 0;
  const number = value => {
    assert(typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value), 'Invalid numeric timing');
    const parsed = Number(value); assert(Number.isFinite(parsed), 'Non-finite timing'); return parsed;
  };
  for (const { observation, enter, exit, timing } of records.values()) {
    if (enter.length !== 1 || exit.length !== 1 || timing.length !== 1) {
      incomplete.push({ correlationId: observation.correlationId, reason: 'MISSING_OR_DUPLICATE_LOG' }); continue;
    }
    try {
      const fields = {};
      for (const [, name, value] of timing[0].matchAll(/\b(\w+)=([^\s]+)/g)) {
        assert(!Object.hasOwn(fields, name)); fields[name] = value;
      }
      assert(uuid.test(fields.scanId) && (observation.status === 0 && !observation.scanId
        || uuid.test(observation.scanId) && fields.scanId === observation.scanId));
      assert(['NEW_SCAN', 'REPLAY', 'FAILED'].includes(fields.outcome));
      assert(['COMMITTED', 'ROLLED_BACK', 'UNKNOWN', 'NOT_OBSERVED'].includes(fields.transactionStatus));
      const bodyMs = number(fields.bodyMs), completionAfterBodyMs = number(fields.completionAfterBodyMs);
      const stages = /\bstagesMs=\{([^}]+)\}/.exec(timing[0]); assert(stages);
      const values = {};
      for (const field of stages[1].split(/,\s*/)) {
        const [name, value, extra] = field.split('=');
        assert(stageNames.has(name) && !Object.hasOwn(values, name) && extra === undefined);
        values[name] = number(value);
      }
      assert(Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - bodyMs) <= 1);
      if (fields.transactionStatus === 'COMMITTED') committedObserved++;
      const exited = /\bstatus=(\d+) completed=(true|false) elapsedMs=([^\s]+)/.exec(exit[0]); assert(exited);
      assert(Number(exited[1]) === observation.status && exited[2] === 'true');
      const filterMs = number(exited[3]);
      rows.push({ correlationId: observation.correlationId, elapsedMs: observation.elapsedMs, filterMs,
        bodyMs, completionAfterBodyMs, withinFilterOutsideServiceMs: filterMs - bodyMs - completionAfterBodyMs,
        outsideFilterResidualMs: observation.elapsedMs - filterMs });
      for (const [name, value] of Object.entries(values)) (stageValues[name] ??= []).push(value);
    } catch { incomplete.push({ correlationId: observation.correlationId, reason: 'INVALID_OR_MISMATCHED_TIMING' }); }
  }
  const stats = values => {
    values.sort((a, b) => a - b);
    const percentile = p => values[Math.ceil(values.length * p) - 1];
    return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), min: values[0], max: values.at(-1) };
  };
  const keys = ['elapsedMs', 'filterMs', 'bodyMs', 'completionAfterBodyMs',
    'withinFilterOutsideServiceMs', 'outsideFilterResidualMs'];
  return { scope: 'Correlated monotonic durations; nearest-rank per-stage percentiles, never add independent p95s. '
      + 'Residuals include auth, transaction entry, serialization, scheduling and transport; not isolated SQL/network. '
      + 'COMMITTED is a matched service log, not durable receipt reconciliation. Negative residuals are retained.',
    requests: observations.length, matched: rows.length, complete: rows.length > 0 && incomplete.length === 0,
    acceptedResponses: observations.filter(o => [200, 202].includes(o.status)).length,
    transportFailures: observations.filter(o => o.status === 0).length, committedObserved, incomplete,
    timingsMs: rows.length ? Object.fromEntries(keys.map(k => [k, stats(rows.map(r => r[k]))])) : null,
    stagesMs: Object.fromEntries(Object.entries(stageValues).map(([k, values]) => [k, stats(values)])),
    slowest: rows.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5) };
}

function run(command, args, { env = process.env, log, allowed = [0], timeout = 600_000, cwd = repo } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true });
    const stream = log ? createWriteStream(log, { flags: 'wx' }) : null;
    let output = '';
    const timer = setTimeout(() => child.kill(), timeout);
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', b => { if (stream) stream.write(b); else output += b.toString(); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => {
      clearTimeout(timer);
      const finish = () => allowed.includes(code) ? resolve({ code, output }) : reject(new Error(`${path.basename(command)} failed (${code}); inspect evidence`));
      if (stream) stream.end(finish); else finish();
    });
  });
}

async function sources() {
  const items = [];
  async function walk(root) {
    for (const entry of await readdir(path.join(repo, root), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Source symlink unsupported');
      const name = `${root}/${entry.name}`;
      if (entry.isDirectory()) await walk(name); else items.push({ path: name, sha256: hash(await readFile(path.join(repo, name))) });
    }
  }
  for (const root of ['backend/src', 'crawler/internal', 'crawler/cmd', 'crawler/migrations', 'capture-worker/src', 'capture-worker/migrations', 'tools/load/k6']) await walk(root);
  for (const name of ['backend/pom.xml', 'crawler/go.mod', 'crawler/go.sum', 'crawler/Dockerfile', 'capture-worker/Dockerfile', 'capture-worker/package-lock.json', 'capture-worker/tsconfig.json', 'tools/load/local-platform-benchmark.mjs']) items.push({ path: name, sha256: hash(await readFile(path.join(repo, name))) });
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

export async function main(args) {
  assert(args.includes('--acknowledge-high-load') && new Set(args).size === args.length
    && args.every(a => ['--acknowledge-high-load', '--api-only', '--admission-only', '--clone-only', '--balanced-mix'].includes(a))
    && args.filter(a => ['--api-only', '--admission-only', '--clone-only'].includes(a)).length <= 1
    && (!args.includes('--balanced-mix') || args.includes('--api-only')),
  'Usage: node tools/load/local-platform-benchmark.mjs --acknowledge-high-load [--api-only [--balanced-mix] | --admission-only | --clone-only] (build current backend/crawler/capture first)');
  const mode = args.includes('--api-only') ? 'API_ONLY' : args.includes('--admission-only') ? 'ADMISSION_ONLY' : args.includes('--clone-only') ? 'CLONE_ONLY' : 'FULL_STACK';
  const cloneMode = mode === 'FULL_STACK' || mode === 'CLONE_ONLY';
  const balancedMix = args.includes('--balanced-mix');
  assertLocalDockerHost(process.env.DOCKER_HOST);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WEBLENS_|SPRING_|DB_|CRAWLER_|CAPTURE_|S3_|CLICKHOUSE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$)/i.test(k)));
  const docker = (args, opts = {}) => run('docker', args, { env: cleanEnv, ...opts });
  const context = JSON.parse((await docker(['context', 'inspect'])).output)[0];
  assert(/^(npipe:\/\/|unix:\/\/)/.test(context.Endpoints.docker.Host), 'Local Docker only');
  const runId = randomUUID(), short = runId.slice(0, 8), label = 'weblens.platform-benchmark';
  const network = `weblens-bench-${short}`, ingress = `weblens-bench-ingress-${short}`;
  const output = path.join(repo, 'tmp/load', `platform-${runId}`);
  await mkdir(output, { recursive: true });
  console.log(`Evidence: ${output}`);
  const inputSources = await sources();
  const jars = (await readdir(path.join(repo, 'backend/target'))).filter(n => /^weblens-backend-.*\.jar$/.test(n));
  assert.equal(jars.length, 1);
  const jar = path.join(repo, 'backend/target', jars[0]);
  const imageNames = ['postgres:17.6-alpine', 'redis:7.4-alpine', 'clickhouse/clickhouse-server:26.3', 'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z', 'maven:3.9-eclipse-temurin-21', 'weblens-benchmark-crawler:20261013', 'weblens-benchmark-capture:20261013'];
  const images = [];
  for (const image of imageNames) {
    const info = JSON.parse((await docker(['image', 'inspect', image])).output)[0];
    images.push({ name: image, id: info.Id });
  }
  await json(path.join(output, 'manifest.json'), { runId, createdAt: new Date().toISOString(), scope: `LOCAL_SYNTHETIC_${mode}`, releaseEligible: false,
    sourceHead: (await run('git', ['rev-parse', 'HEAD'])).output.trim(), dirtySource: true, sources: inputSources, sourceDigest: hash(JSON.stringify(inputSources)), jarSha256: hash(await readFile(jar)), images,
    host: { platform: os.platform(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem() },
    network: { internal: true, subnet: '11.254.254.0/24', fixtureAddress, note: 'Public-form addresses exist ONLY in internal Docker namespace; no Internet route. SSRF code unchanged; not production egress evidence.' },
    config: { postgres: '2 CPU/1 GiB, 3 separate databases', clickhouse: '2 CPU/1536 MiB', backend: '2 CPU/1536 MiB, heap 1024 MiB, Hikari 32/16; sole ingress bridge member', capture: '2 CPU/2 GiB, Camoufox headless, 2 pages/process', crawler: '2 CPU/768 MiB, 16 fetches/global, 2/host, zero synthetic host delay', billing: false, mixedRouteOffset: balancedMix, billingWorkaround: false },
    limitations: ['Same-machine generator/targets', 'Small synthetic payload and empty fresh database, not 100k accounts or 12-month history', 'No Caddy/TLS or production hardware', 'No matched before/after baseline', 'No real payment, login-session clone, WAF/CAPTCHA, crash recovery or soak beyond this bounded run'] });
  const containers = [], results = [], cleanup = [];
  let createdNetwork = false, createdIngress = false, sampling, sampleBusy = false, samples = [], outcome = 'FAILED';
  const password = randomBytes(24).toString('hex'), serviceToken = randomBytes(32).toString('hex');
  try {
    await docker(['network', 'create', '--internal', '--subnet', '11.254.254.0/24', '--label', `${label}=${runId}`, network]);
    createdNetwork = true;
    assert.equal(JSON.parse((await docker(['network', 'inspect', network])).output)[0].Internal, true);
    await docker(['network', 'create', '--label', `${label}=${runId}`, ingress]); createdIngress = true;
    async function container(name, image, vars, extra = [], command = []) {
      const fullName = `wb-${short}-${name}`;
      const id = (await docker(['run', '-d', '--network', network, '--network-alias', name, '--name', fullName,
        '--label', `${label}=${runId}`, ...Object.keys(vars).flatMap(k => ['-e', k]), ...extra, image, ...command],
      { env: { ...cleanEnv, ...vars } })).output.trim();
      assert(/^[0-9a-f]{64}$/.test(id), 'Invalid container ID');
      containers.push({ name, id });
      // Internal Docker bridges do not publish ingress ports. Only Java receives
      // this second bridge; browser, crawler and fixture remain Internet-isolated.
      if (name === 'control') await docker(['network', 'connect', ingress, id]);
      const details = JSON.parse((await docker(['inspect', id])).output)[0];
      assert.deepEqual(Object.keys(details.NetworkSettings.Networks).sort(), (name === 'control' ? [network, ingress] : [network]).sort());
      return { name, id, port: p => Number(details.NetworkSettings.Ports[`${p}/tcp`][0].HostPort) };
    }
    const pg = await container('postgres', imageNames[0], { POSTGRES_USER: 'bench', POSTGRES_DB: 'control', POSTGRES_PASSWORD: password }, ['--cpus', '2', '--memory', '1g', '-p', '127.0.0.1::5432']);
    for (let i = 0; ; i++) {
      try { await docker(['exec', pg.id, 'pg_isready', '-U', 'bench']); break; } catch { assert(i < 45, 'PostgreSQL readiness timeout'); await delay(1000); }
    }
    const sql = (db, query) => docker(['exec', '-e', 'PGOPTIONS=-c statement_timeout=5000', pg.id, 'psql', '-X', '-U', 'bench', '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', query]);
    await sql('control', 'CREATE DATABASE crawler'); await sql('control', 'CREATE DATABASE capture');
    await container('redis', imageNames[1], {}, ['--memory', '128m'], ['redis-server', '--save', '', '--appendonly', 'no']);
    await container('clickhouse', imageNames[2], { CLICKHOUSE_USER: 'bench', CLICKHOUSE_PASSWORD: password, CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' }, ['--cpus', '2', '--memory', '1536m']);
    const minio = await container('minio', imageNames[3], { MINIO_ROOT_USER: 'bench', MINIO_ROOT_PASSWORD: password }, ['--memory', '512m', '-p', '127.0.0.1::9000'], ['server', '/data']);
    for (let i = 0; ; i++) {
      try { await docker(['exec', minio.id, 'mc', 'alias', 'set', 'bench', 'http://127.0.0.1:9000', 'bench', password]); break; } catch { assert(i < 45, 'MinIO readiness timeout'); await delay(1000); }
    }
    await docker(['exec', minio.id, 'mc', 'mb', 'bench/benchmark']);
    await container('fixture', imageNames[6], {}, ['--memory', '192m', '--ip', fixtureAddress, '--entrypoint', 'node', '--mount', `type=bind,source=${path.join(repo, 'tools/load')},target=/test,readonly`], ['/test/local-platform-benchmark.mjs', '--fixture']);
    const backend = await container('control', imageNames[4], { DB_URL: 'jdbc:postgresql://postgres:5432/control', DB_USERNAME: 'bench', DB_PASSWORD: password,
      WEBLENS_JWT_SECRET: randomBytes(48).toString('hex'), WEBLENS_SERVICE_TOKEN: serviceToken, WEBLENS_REDIS_HOST: 'redis', WEBLENS_REDIS_PORT: '6379',
      WEBLENS_HIKARI_MAX_POOL_SIZE: '32', WEBLENS_ADMISSION_LOG_LEVEL: 'DEBUG', WEBLENS_BILLING_ENABLED: 'false', WEBLENS_SCAN_CONCURRENCY: '16',
      WEBLENS_CRAWLER_COMMAND_URL: 'http://crawler:8081/internal/v1/commands/scans', WEBLENS_CRAWLER_REPORT_BASE_URL: 'http://crawler:8081',
      WEBLENS_CAPTURE_COMMAND_URL: 'http://capture:8082/internal/v1/commands/captures', WEBLENS_SITE_CLONE_COMMAND_URL: 'http://capture:8082/internal/v1/commands/site-clones', WEBLENS_CAPTURE_REPORT_BASE_URL: 'http://capture:8082' },
    ['--cpus', '2', '--memory', '1536m', '-p', '127.0.0.1::8080', '--mount', `type=bind,source=${jar},target=/test/app.jar,readonly`, '--entrypoint', 'java'], ['-Xms256m', '-Xmx1024m', '-jar', '/test/app.jar']);
    const crawler = await container('crawler', imageNames[5], { CRAWLER_POSTGRES_URL: `postgresql://bench:${password}@postgres:5432/crawler`, CRAWLER_SERVICE_TOKEN: serviceToken,
      CRAWLER_CLICKHOUSE_ADDR: 'clickhouse:9000', CRAWLER_CLICKHOUSE_USERNAME: 'bench', CRAWLER_CLICKHOUSE_PASSWORD: password, CRAWLER_MIGRATE_ON_START: 'true', CRAWLER_WORKER_CONCURRENCY: '16', CRAWLER_HOST_DELAY: '0s',
      CRAWLER_CONTROL_EVENTS_URL: 'http://control:8080/internal/v1/events/scans' }, ['--cpus', '2', '--memory', '768m', '-p', '127.0.0.1::8081']);
    const capture = await container('capture', imageNames[6], { WEBLENS_SERVICE_TOKEN: serviceToken, CAPTURE_DATABASE_URL: `postgresql://bench:${password}@postgres:5432/capture`,
      CLICKHOUSE_URL: 'http://clickhouse:8123', CLICKHOUSE_USERNAME: 'bench', CLICKHOUSE_PASSWORD: password, S3_ENDPOINT: 'http://minio:9000', S3_ACCESS_KEY: 'bench', S3_SECRET_KEY: password, S3_CAPTURE_BUCKET: 'benchmark',
      WEBLENS_CONTROL_CAPTURE_EVENT_URL: 'http://control:8080/internal/v1/events/captures', WEBLENS_CONTROL_SITE_CLONE_EVENT_URL: 'http://control:8080/internal/v1/events/site-clones', WEBLENS_CRAWLER_REPORT_BASE_URL: 'http://crawler:8081',
      CAPTURE_BROWSER_HEADLESS: 'true', CAPTURE_RECONSTRUCTION_GC_POLL_MS: '1000' }, ['--cpus', '2', '--memory', '2g', '--shm-size', '256m', '-p', '127.0.0.1::8082']);
    const base = `http://127.0.0.1:${backend.port(8080)}`;
    await json(path.join(output, 'containers.json'), { network, containers, base });
    for (const [origin, route] of [[base, '/actuator/health'], ['http://crawler:8081', '/health/ready'], ['http://capture:8082', '/health/ready']]) {
      for (let i = 0; ; i++) {
        try {
          if (origin === base) { const r = await fetch(origin + route, { signal: AbortSignal.timeout(2000) }); if (r.ok && (await r.json()).status === 'UP') break; }
          else { await docker(['exec', capture.id, 'node', '-e', `fetch('${origin + route}',{signal:AbortSignal.timeout(2000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='UP')process.exit(1)}).catch(()=>process.exit(1))`], { timeout: 5000 }); break; }
        } catch {}
        assert(i < 120, 'Platform readiness timeout'); await delay(1000);
      }
    }
    sampling = setInterval(async () => {
      if (sampleBusy) return; sampleBusy = true;
      try {
        const stats = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...containers.map(c => c.id)], { timeout: 15_000 });
        const metrics = {};
        for (const name of ['hikaricp.connections.active', 'hikaricp.connections.pending', 'hikaricp.connections.timeout', 'tomcat.threads.busy']) {
          try {
            const response = await fetch(`${base}/actuator/metrics/${name}`, { headers: { 'X-WebLens-Service-Token': serviceToken }, signal: AbortSignal.timeout(2000) });
            metrics[name] = response.ok ? (await response.json()).measurements : { status: response.status };
          } catch { metrics[name] = { unavailable: true }; }
        }
        samples.push({ at: new Date().toISOString(), freeHostMemory: os.freemem(), metrics, containers: stats.output.trim().split(/\r?\n/).map(s => JSON.parse(s)) });
      } catch { samples.push({ at: new Date().toISOString(), unavailable: true }); }
      finally { sampleBusy = false; }
    }, 10_000);
    async function request(route, { token, method = 'GET', body, headers = {}, expected = 200 } = {}) {
      const r = await fetch(base + route, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(r.status, expected, `${method} ${route}: HTTP ${r.status}`);
      return r;
    }
    async function register(index) {
      await delay(1100);
      const email = `benchmark-${short}-${index}@example.test`;
      const auth = await (await request('/api/v1/auth/registrations', { method: 'POST', expected: 201, body: { email, password, displayName: 'Synthetic owner' } })).json();
      const website = await (await request('/api/v1/websites', { method: 'POST', token: auth.accessToken, expected: 201, body: { name: 'Synthetic fixture', url: `http://${fixtureAddress}:9090/leaf/${index}` } })).json();
      return { index, accountIndex: index, email, websiteId: website.id, token: auth.accessToken, correlationId: randomUUID() };
    }
    const owner = cloneMode ? await register('clone') : null;
    const stranger = cloneMode ? await register('stranger') : null;
    async function waitClone(created, token, timeoutMs = 600_000) {
      const snapshots = [], started = Date.now();
      let previousProcessed = 0;
      while (Date.now() - started < timeoutMs) {
        const state = await (await request(`/api/v1/site-clones/${created.id}`, { token })).json();
        assert(state.processedCount >= previousProcessed, 'Clone progress regressed'); previousProcessed = state.processedCount;
        const last = snapshots.at(-1);
        if (!last || state.status !== last.status || state.processedCount !== last.processedCount) snapshots.push({ at: new Date().toISOString(), ...state });
        if (['PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(state.status)) return { state, elapsedMs: Date.now() - started, snapshots };
        await delay(2000);
      }
      await json(path.join(output, `clone-${created.id}-timeout.json`), snapshots);
      throw new Error('Clone workflow deadline exceeded; not a successful clone');
    }
    async function clone(n, suffix, actor = owner) {
      const outsider = actor === owner ? stranger : owner;
      console.log(`Clone: ${n} discovered URLs (${suffix})`);
      const started = Date.now(), key = randomUUID();
      const created = await (await request('/api/v1/site-clones', { method: 'POST', token: actor.token, body: { url: fixtureRoot(n) }, headers: { 'Idempotency-Key': key }, expected: 202 })).json();
      const replay = await (await request('/api/v1/site-clones', { method: 'POST', token: actor.token, body: { url: fixtureRoot(n) }, headers: { 'Idempotency-Key': key } })).json();
      assert.equal(replay.id, created.id); assert.equal(replay.scanId, created.scanId);
      await request(`/api/v1/site-clones/${created.id}`, { token: outsider.token, expected: 404 });
      const observation = await waitClone(created, actor.token);
      const evidence = { n, suffix, admissionMs: Date.now() - started - observation.elapsedMs, ...observation, pass: false };
      await json(path.join(output, `clone-${suffix}-lifecycle.json`), evidence);
      assert(['PUBLISHED', 'PARTIAL'].includes(observation.state.status), `Clone terminal ${observation.state.status}`);
      assert.equal(observation.state.websiteId, created.websiteId, 'Control Plane website metadata changed');
      // PostgreSQL stores microseconds; Java's pre-commit response may retain nanoseconds.
      assert(Math.abs(Date.parse(observation.state.createdAt) - Date.parse(created.createdAt)) <= 1,
        'Public accepted timestamp changed beyond persistence precision');
      assert.equal(observation.state.scanId, created.scanId, 'Worker report scan identity changed');
      const artifacts = [], entries = new Map(); let manifest;
      for (const a of observation.state.artifacts) {
        const route = `/api/v1/site-clones/${created.id}/artifacts/${a.id}`;
        await request(route, { token: outsider.token, expected: 404 });
        const response = await request(route, { token: actor.token });
        assert.match(response.headers.get('content-disposition') || '', /attachment/i);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.match(response.headers.get('cache-control') || '', /no-store/);
        assert(a.byteSize <= 64 * 1024 * 1024, 'Fixture download byte budget');
        const body = Buffer.from(await response.arrayBuffer());
        assert.equal(body.length, a.byteSize); assert.equal(hash(body), a.sha256);
        await writeFile(path.join(output, `${suffix}-${a.kind}-${a.shardNumber}.${a.kind === 'MANIFEST' ? 'json' : 'zip'}`), body, { flag: 'wx' });
        artifacts.push({ ...a, verified: true });
        if (a.kind === 'MANIFEST') manifest = JSON.parse(body.toString('utf8'));
        else for (const [name, value] of zipEntries(body)) { assert(!entries.has(name), 'Duplicate cross-shard path'); entries.set(name, value); }
      }
      assert(manifest, 'Missing downloaded manifest');
      assert.equal(observation.state.totalArchiveBytes,
        artifacts.reduce((sum, a) => sum + a.byteSize, 0),
        'Public archive bytes do not match published artifacts (shards + manifest)');
      const roles = new Set(manifest.representatives.map(p => p.semanticRole));
      for (const role of ['AUTH_LOGIN', 'AUTH_REGISTER', 'AUTH_FORGOT_PASSWORD', 'BLOG_INDEX', 'BLOG_DETAIL', 'USE_CASE_INDEX', 'USE_CASE_DETAIL', 'PRICING', 'ERROR_4XX']) assert(roles.has(role), `Missing representative ${role}`);
      assert.equal(manifest.locale, 'vi'); assert.equal(manifest.counts.discovered, n);
      assert.equal(manifest.policy.screenshot, false); assert(![...entries.keys()].some(n => /screenshot/i.test(n)));
      assert.equal([...entries.keys()].filter(n => n.endsWith('.css')).length, 1, 'CSS not deduplicated');
      assert.equal([...entries.keys()].filter(n => n.endsWith('.js')).length, 1, 'JS not deduplicated');
      assert(manifest.rejected.reasonCounts.ALTERNATE_LOCALE >= 1);
      for (const [name, body] of entries) {
        if (!name.endsWith('.html')) continue;
        const html = body.toString('utf8'); assert.match(html, /data-fixture="rendered"/);
        for (const [, attr] of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
          if (/^(https?:|data:|mailto:|javascript:)/i.test(attr)) continue;
          const local = path.posix.normalize(path.posix.join(path.posix.dirname(name), attr.split('#')[0]));
          assert(entries.has(local), `Broken offline reference ${name} -> ${local}`);
        }
      }
      const result = { ...evidence, totalElapsedMs: Date.now() - started, pass: true, artifacts, manifestCounts: manifest.counts, rejectionCounts: manifest.rejected.reasonCounts, archiveEntries: entries.size };
      await json(path.join(output, `clone-${suffix}-verified.json`), result);
      console.log(`Clone ${suffix}: ${observation.state.status}, packaged=${manifest.counts.packaged}, total=${result.totalElapsedMs}ms, verified=true`);
      return result;
    }
    let clonePass = true;
    try {
      if (cloneMode) {
        results.push({ scenario: 'clone-smoke', ...await clone(100, 'smoke') });
        results.push({ scenario: 'clone-large', ...await clone(1000, 'large') });
        if (mode === 'CLONE_ONLY') {
          const concurrent = await Promise.allSettled([clone(100, 'concurrent-a'), clone(100, 'concurrent-b', stranger)]);
          concurrent.forEach((result, index) => {
            if (result.status === 'fulfilled') results.push({ scenario: `clone-concurrent-${index}`, ...result.value });
            else { clonePass = false; results.push({ scenario: `clone-concurrent-${index}`, pass: false, error: result.reason.message }); }
          });
        }
      }
    }
    catch (e) { clonePass = false; results.push({ scenario: 'clone', pass: false, error: e.message }); console.log(`Clone gate failed: ${e.message}`); }
    // Admission runs independently even if rendering fails; it never retries a timed-out POST.
    const users = [];
    for (let i = 0; i < (mode === 'CLONE_ONLY' ? 0 : mode === 'ADMISSION_ONLY' ? 150 : 25); i++) users.push(await register(i));
    async function admission(entries, name) {
      const seed = path.join(output, `admission-${name}-seed.json`), levelId = randomUUID();
      await json(seed, { entries: entries.map(({ token, ...safe }) => safe) });
      const log = path.join(output, `admission-${name}.log`), summary = path.join(output, `admission-${name}-summary.json`);
      const res = await run('k6', ['run', '--summary-trend-stats', 'avg,min,med,max,p(90),p(95),p(99)', path.join(repo, 'tools/load/k6/crawler-submit.js')],
        { env: { ...cleanEnv, WEBLENS_BASE_URL: base, WEBLENS_SCAN_COUNT: String(entries.length), WEBLENS_ACK_HIGH_LOAD: '1', WEBLENS_PHASE5_SEED_FILE: seed, WEBLENS_PHASE5_PASSWORD: password, WEBLENS_PHASE5_LEVEL_ID: levelId, WEBLENS_SAFE_SUMMARY_FILE: summary }, log, allowed: [0, 99] });
      const observations = parseObservations(await readFile(log, 'utf8'));
      const ids = entries.map(e => `'${e.correlationId}'`).join(',');
      const durable = JSON.parse((await sql('control', `SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT s.id AS "scanId", s.website_id AS "websiteId", o.correlation_id AS "correlationId" FROM scans s JOIN outbox_events o ON o.aggregate_id=s.id WHERE o.event_type='SCAN_REQUESTED' AND o.correlation_id IN (${ids})) r`)).output);
      const consistent = admissionsConsistent(entries, observations, durable);
      const metrics = JSON.parse(await readFile(summary, 'utf8')).metrics;
      const result = { scenario: `admission-${name}`, count: entries.length, pass: res.code === 0 && consistent, k6Exit: res.code, consistent, observations, durable, elapsed: metrics.scan_admission_elapsed?.values || metrics.scan_admission_elapsed };
      await json(path.join(output, `admission-${name}-verified.json`), result); results.push(result);
      try {
        const backendLog = (await docker(['logs', backend.id])).output;
        await json(path.join(output, `admission-${name}-timing.json`), summarizeAdmissionTimings(observations, backendLog));
      } catch { await json(path.join(output, `admission-${name}-timing.json`), { unavailable: true }); }
      if (consistent) for (const o of observations) entries[o.index].scanId = o.scanId;
      console.log(`Admission ${name}: pass=${result.pass}, accepted=${observations.filter(o => o.status === 202).length}/${entries.length}, p95=${result.elapsed?.['p(95)']}ms`);
      return result.pass;
    }
    const admissionPass = mode === 'CLONE_ONLY' ? true : await admission(users, String(users.length));
    if (admissionPass && mode !== 'ADMISSION_ONLY' && mode !== 'CLONE_ONLY') {
      for (const user of users) {
        for (let i = 0; ; i++) {
          const scan = await (await request(`/api/v1/scans/${user.scanId}`, { token: user.token })).json();
          if (['COMPLETED', 'PARTIAL_SUCCESS'].includes(scan.status)) break;
          assert(i < 60 && !['FAILED', 'CANCELLED'].includes(scan.status), 'Seed scan did not complete'); await delay(1000);
        }
      }
      const seed = path.join(output, 'mixed-seed.json');
      await json(seed, { users: users.map(({ email, websiteId, scanId }) => ({ email, websiteId, scanId })) });
      async function cpuSnapshot() {
        const snapshot = {};
        for (const item of [backend, crawler, containers.find(c => c.name === 'clickhouse')]) {
          try {
            snapshot[item.name] = { at: new Date().toISOString(), text: (await docker(['exec', item.id,
              'cat', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/cpu.stat'], { timeout: 5000 })).output };
          } catch { snapshot[item.name] = { unavailable: true }; }
        }
        return snapshot;
      }
      for (const [name, rate, duration] of [['baseline', 50, '60s'], ['burst', 150, '60s'], ['stress', 500, '120s'], ['soak', 150, '300s']]) {
        console.log(`API ${name}: offered ${rate} RPS / ${duration}, 25 authenticated owners, fresh real scan reports`);
        const summary = path.join(output, `api-${name}-summary.json`);
        const cpuBefore = await cpuSnapshot();
        const res = await run('k6', ['run', path.join(repo, 'tools/load/k6/mixed-activity.js')], { log: path.join(output, `api-${name}.log`), allowed: [0, 99],
          env: { ...cleanEnv, WEBLENS_BASE_URL: base, WEBLENS_ACK_HIGH_LOAD: '1', WEBLENS_MIXED_SEED_FILE: seed, WEBLENS_MIXED_PASSWORD: password, WEBLENS_MIXED_VUS: '25', WEBLENS_MIXED_THINK_SECONDS: '0', WEBLENS_MIXED_RATE: String(rate), WEBLENS_MIXED_DURATION: duration, WEBLENS_SAFE_SUMMARY_FILE: summary, WEBLENS_TRACE_ERRORS: '1', WEBLENS_MIXED_ROUTE_OFFSET: balancedMix ? '1' : '0' } });
        const cpuAfter = await cpuSnapshot(), cpuQuota = {};
        for (const item of Object.keys(cpuBefore)) {
          try { cpuQuota[item] = { from: cpuBefore[item].at, to: cpuAfter[item].at,
            ...summarizeCpuQuota(cpuBefore[item].text, cpuAfter[item].text) }; }
          catch { cpuQuota[item] = { unavailable: true }; }
        }
        await json(path.join(output, `api-${name}-cpu-quota.json`), {
          scope: 'Cgroup v2 counters around the entire k6 invocation, including setup/login; not request latency or activity-only utilization',
          containers: cpuQuota });
        const metrics = JSON.parse(await readFile(summary, 'utf8')).metrics;
        const result = { scenario: `api-${name}`, offeredRps: rate, duration, pass: res.code === 0, k6Exit: res.code, metrics };
        const reportStages = {};
        for (const stage of ['authorization', 'remote']) {
          const response = await fetch(`${base}/actuator/metrics/weblens.scan.report.stage?tag=stage:${stage}`, {
            headers: { 'X-WebLens-Service-Token': serviceToken }, signal: AbortSignal.timeout(2000) });
          reportStages[stage] = response.ok ? (await response.json()).measurements : { status: response.status };
        }
        await json(path.join(output, `api-${name}-report-stages.json`), { at: new Date().toISOString(),
          scope: 'Cumulative timer since process startup; COUNT/TOTAL/MAX, not per-request percentiles', reportStages });
        await json(path.join(output, `api-${name}-verified.json`), result); results.push(result);
        console.log(`API ${name}: pass=${result.pass}`);
        if (!result.pass) break;
      }
      if (mode === 'FULL_STACK' && results.filter(r => r.scenario.startsWith('api-')).every(r => r.pass)) {
        const burstUsers = [];
        for (let i = 0; i < 150; i++) burstUsers.push(await register(i + 25));
        await admission(burstUsers, '150');
      }
    }
    if (mode === 'CLONE_ONLY' && clonePass) {
      const testProbe = `import {spawnSync} from 'node:child_process';
        process.env.CAPTURE_TEST_DATABASE_URL=process.env.CAPTURE_DATABASE_URL;
        process.env.CAPTURE_TEST_S3_ENDPOINT=process.env.S3_ENDPOINT;
        process.env.CAPTURE_TEST_S3_ACCESS_KEY=process.env.S3_ACCESS_KEY;
        process.env.CAPTURE_TEST_S3_SECRET_KEY=process.env.S3_SECRET_KEY;
        process.env.CAPTURE_TEST_S3_BUCKET=process.env.S3_CAPTURE_BUCKET;
        const result=spawnSync(process.execPath,['--test','dist/database.integration.test.js','dist/storage.integration.test.js'],{stdio:'inherit'});
        process.exit(result.status??1);`;
      const integration = await docker(['exec', capture.id, 'node', '--input-type=module', '-e', testProbe], {
        log: path.join(output, 'capture-integration.log'), allowed: [0, 1], timeout: 120000 });
      results.push({ scenario: 'capture-postgres-minio-integration', pass: integration.code === 0, exit: integration.code });
      let inventory;
      for (let i = 0; i < 30; i++) {
        inventory = (await docker(['exec', minio.id, 'mc', 'ls', '--recursive', '--json', 'bench/benchmark'])).output
          .trim().split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row));
        if (inventory.every(item => typeof item.key === 'string' && item.key.includes('/artifacts/'))) break;
        await delay(1000);
      }
      const expectedArtifacts = results.filter(r => r.scenario.startsWith('clone-') && r.pass)
        .reduce((sum, r) => sum + r.artifacts.length, 0);
      const storageClean = inventory.length === expectedArtifacts
        && inventory.every(item => item.key?.includes('/artifacts/'));
      await json(path.join(output, 'clone-storage-inventory.json'), { expectedArtifacts,
        observedObjects: inventory.length, onlyPublishedArtifacts: storageClean,
        objectBytes: inventory.map(item => item.size) });
      results.push({ scenario: 'clone-staging-gc', pass: storageClean });
    }
    await json(path.join(output, 'postgres-summary.json'), JSON.parse((await sql('control', `SELECT json_build_object('connections',(SELECT count(*) FROM pg_stat_activity),'dbStats',(SELECT json_agg(r) FROM (SELECT datname,numbackends,xact_commit,xact_rollback,deadlocks,temp_bytes,blks_read,blks_hit FROM pg_stat_database WHERE datname IN ('control','crawler','capture')) r))`)).output));
    try {
      // Local metadata only. Never export query text, parameters, headers or exception text.
      const query = `SELECT query_id, toString(type) AS event_type, toString(query_start_time_microseconds) AS started_at,
        query_duration_ms, read_rows, read_bytes, memory_usage, exception_code,
        ProfileEvents['UserTimeMicroseconds'] AS user_cpu_us, ProfileEvents['SystemTimeMicroseconds'] AS system_cpu_us
        FROM system.query_log WHERE query_kind='Select' AND is_initial_query=1 ORDER BY event_time_microseconds LIMIT 50000 FORMAT JSONEachRow`;
      const probe = `const headers={'X-ClickHouse-User':process.env.CLICKHOUSE_USERNAME,'X-ClickHouse-Key':process.env.CLICKHOUSE_PASSWORD};
        for(const query of ['SYSTEM FLUSH LOGS',${JSON.stringify(query)}]){const r=await fetch(process.env.CLICKHOUSE_URL,{method:'POST',headers,body:query,signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('QUERY_METADATA_UNAVAILABLE');const b=await r.text();if(query!=='SYSTEM FLUSH LOGS')process.stdout.write(b)}`;
      const metadata = await docker(['exec', capture.id, 'node', '--input-type=module', '-e', probe], { timeout: 25000 });
      await json(path.join(output, 'clickhouse-query-metadata.json'), metadata.output.trim().split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row)));
    } catch { await json(path.join(output, 'clickhouse-query-metadata.json'), { unavailable: true }); }
    assert.deepEqual(await sources(), inputSources, 'Source changed during experiment');
    outcome = clonePass && results.every(r => r.pass) ? `PASS_${mode}_LOCAL_ONLY` : 'FAILED_GATE';
  } finally {
    clearInterval(sampling);
    while (sampleBusy) await delay(100);
    await json(path.join(output, 'resource-samples.json'), samples);
    for (const item of containers.slice().reverse()) {
      try {
        const details = JSON.parse((await docker(['inspect', item.id])).output)[0];
        assert.equal(details.Config.Labels[label], runId, 'Ownership mismatch');
        await json(path.join(output, `${item.name}-state.json`), { state: details.State, image: details.Image, memory: details.HostConfig.Memory, nanoCpus: details.HostConfig.NanoCpus });
        const logs = await docker(['logs', item.id]);
        await writeFile(path.join(output, `${item.name}.log`), logs.output, { flag: 'wx' });
        await docker(['rm', '-f', '-v', item.id]); cleanup.push({ ...item, removed: true });
      } catch { cleanup.push({ ...item, removed: false }); }
    }
    if (createdNetwork) {
      const details = JSON.parse((await docker(['network', 'inspect', network])).output)[0];
      assert.equal(details.Labels[label], runId, 'Network ownership mismatch');
      await docker(['network', 'rm', network]);
    }
    if (createdIngress) {
      const details = JSON.parse((await docker(['network', 'inspect', ingress])).output)[0];
      assert.equal(details.Labels[label], runId, 'Ingress ownership mismatch'); await docker(['network', 'rm', ingress]);
    }
    await json(path.join(output, 'final.json'), { outcome, results, cleanup, finishedAt: new Date().toISOString() });
    assert(cleanup.every(c => c.removed), 'Cleanup incomplete; inspect final.json');
    console.log(`Outcome: ${outcome}. Only owned temporary containers/volumes removed; evidence retained.`);
  }
  assert(outcome.startsWith('PASS_'), 'Benchmark gate failed; see final.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv.slice(2).join(' ') === '--fixture') {
    // Only starts inside the runner's internal network, never exposes a host port.
    const server = http.createServer((req, res) => {
      const page = fixturePage(new URL(req.url || '/', `http://${fixtureAddress}:9090`));
      res.writeHead(page.status, { 'Content-Type': page.type, 'Content-Length': Buffer.byteLength(page.body), 'Cache-Control': 'no-store' }); res.end(page.body);
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    server.listen(9090, '0.0.0.0', () => console.log('Isolated fixture ready'));
  } else main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
