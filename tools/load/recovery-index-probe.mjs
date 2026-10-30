#!/usr/bin/env node
// Approved scope: isolated index experiment, never a production maintenance runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertKnownOptions, parseCommandLine, stringOption, flag } from './lib/cli.mjs';
import { assertLocalDockerHost } from './local-admission-probe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = 'ix_scan_pages_persisting_recovery';
const eventIndex = 'ix_outbox_dead_recovery';
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = name => { assert(/^[a-z][a-z0-9_]{0,62}$/.test(name)); return `"${name}"`; };
const query = {
  pages: "SELECT EXISTS(SELECT 1 FROM scan_pages WHERE status='PERSISTING')",
  events: "SELECT EXISTS(SELECT 1 FROM outbox_events WHERE status='DEAD')",
};

export function profileFor(name) {
  assert(['smoke', 'representative'].includes(name), 'profile must be smoke or representative');
  return name === 'smoke' ? { september: 15000, october: 15000, events: 60000 }
    : { september: 516071, october: 780640, events: 3499939 };
}

export function indexSteps(partitions) {
  assert(partitions.length > 0 && new Set(partitions).size === partitions.length);
  return [`CREATE INDEX CONCURRENTLY ${eventIndex} ON outbox_events(message_id) WHERE status='DEAD'`,
    `CREATE INDEX ${parent} ON ONLY scan_pages(id) WHERE status='PERSISTING'`,
    ...partitions.flatMap(table => [
      `CREATE INDEX CONCURRENTLY ${quote(`${table}_persisting_recovery`)} ON ${quote(table)}(id) WHERE status='PERSISTING'`,
      `ALTER INDEX ${parent} ATTACH PARTITION ${quote(`${table}_persisting_recovery`)}`,
    ])];
}

export function assertCoverage(rows, expectedTables) {
  assert.equal(rows.length, expectedTables.length + 2, 'Missing or unexpected index coverage');
  assert.deepEqual(rows.filter(row => row.kind === 'leaf').map(row => row.table).sort(), [...expectedTables].sort());
  for (const row of rows) {
    assert(row.valid && row.ready && row.live && !row.unique && row.method === 'btree', 'Invalid index flags');
    assert.equal(row.columns, row.kind === 'event' ? 'message_id' : 'id');
    assert.equal(row.attributeCount, 1, 'Unexpected INCLUDE or extra key');
    assert.equal(row.predicate, row.kind === 'event' ? "(status = 'DEAD'::text)" : "(status = 'PERSISTING'::text)");
    if (row.kind === 'leaf') assert.equal(row.parent, parent, 'Leaf is not attached to the candidate parent');
  }
  assert.equal(rows.filter(row => row.kind === 'parent').length, 1);
  assert.equal(rows.filter(row => row.kind === 'event').length, 1);
}

export function assertSelectivePlan(plan, scope, expectedTables, largeTables = expectedTables) {
  const leaves = [];
  function walk(node) {
    if (node['Relation Name']) leaves.push(node);
    for (const child of node.Plans || []) walk(child);
  }
  walk(plan.Plan);
  assert.deepEqual(leaves.map(node => node['Relation Name']).sort(), [...expectedTables].sort());
  assert(leaves.filter(node => largeTables.includes(node['Relation Name'])).every(node => /Index.*Scan/.test(node['Node Type'])
    && (scope === 'pages' ? node['Index Name']?.includes('persisting') : node['Index Name'] === eventIndex)),
  'Recovery plan does not use every required selective index');
}

export function timedNotice(stderr) {
  const line = stderr.split(/\r?\n/).find(row => row.includes('RECOVERY_WRITE|'));
  assert(line, 'Missing server-side write timing');
  const value = JSON.parse(line.slice(line.indexOf('RECOVERY_WRITE|') + 'RECOVERY_WRITE|'.length));
  assert(['elapsedMs', 'walBytes', 'rows'].every(key => Number.isFinite(value[key]) && value[key] >= 0));
  assert(value.rows > 0);
  return value;
}

export function summarize(values) {
  assert(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(fraction * sorted.length) - 1];
  return { samples: sorted.length, median: percentile(.5), p95: percentile(.95), max: sorted.at(-1) };
}

export function baselineReadTimeout(mode, code, stderr) {
  if (code === 0) return null;
  assert(mode === 'before' && code === 3 && /ERROR:\s*57014\b/.test(stderr),
    'Only a baseline statement timeout may be recorded without stopping candidate validation');
  return { outcome: 'TIMEOUT', executionMs: null, sqlstate: '57014', timeoutMs: 2000 };
}

function run(command, args, { cwd = repo, env = process.env, input, allowed = [0], timeout = 180000, safeDiagnostic = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (!timedOut && allowed.includes(code)) resolve({ code, stdout, stderr });
      else reject(new Error(`${path.basename(command)} failed (${code}, timeout=${timedOut}); SQLSTATE=${stderr.match(/ERROR:\s*([0-9A-Z]{5})/)?.[1] || 'unknown'}; constraint=${stderr.match(/violates check constraint "([a-z0-9_]+)"/)?.[1] || 'unknown'}${safeDiagnostic ? '; ' + stderr.split(/\r?\n/).filter(line => /ERROR|FATAL|psql:|Error response from daemon/.test(line)).join(' ').slice(0, 1600) : ''}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function hashes(root) {
  const result = [];
  async function walk(relative) {
    for (const file of await readdir(path.join(root, relative), { withFileTypes: true })) {
      assert(!file.isSymbolicLink());
      const name = path.join(relative, file.name);
      if (file.isDirectory()) await walk(name);
      else result.push({ path: name.replaceAll('\\', '/'), sha256: sha(await readFile(path.join(root, name))) });
    }
  }
  for (const folder of ['cmd', 'internal', 'migrations']) await walk(folder);
  for (const name of ['go.mod', 'go.sum']) result.push({ path: name, sha256: sha(await readFile(path.join(root, name))) });
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function seedPages(month, count, start = 1, batch = count) {
  assert(Number.isInteger(start) && start >= 1 && start <= count && Number.isInteger(batch) && batch > 0);
  return (start === 1 ? `INSERT INTO crawl_executions(id,scan_id,owner_id,website_id,retention_month,status,command_version,
    target_url,target_hostname,max_pages,max_depth,max_response_bytes,max_duration_seconds,max_redirects,
    max_concurrency,collector_version,discovered_count,succeeded_count,accepted_at,finished_at,updated_at)
    SELECT md5('execution_${month}_'||g)::uuid,md5('scan_${month}_'||g)::uuid,md5('owner_'||(g%150))::uuid,
    md5('website_${month}_'||g)::uuid,'${month}','COMPLETED',1,'https://fixture.invalid/','fixture.invalid',
    1000,2,1048576,3600,3,2,'recovery-probe',least(1000,${count}-g*1000),least(1000,${count}-g*1000),
    '${month}'::timestamptz,'${month}'::timestamptz,'${month}'::timestamptz FROM generate_series(0,(${count}-1)/1000) g;` : '') + `
    INSERT INTO scan_pages(retention_month,id,execution_id,owner_id,normalized_url,normalized_url_sha256,
    hostname,hostname_sha256,discovery_depth,status,available_at,discovered_at,completed_at,updated_at)
    SELECT '${month}',md5('page_${month}_'||n)::uuid,md5('execution_${month}_'||((n-1)/1000))::uuid,
    md5('owner_'||(((n-1)/1000)%150))::uuid,'https://fixture.invalid/${month}/'||n,
    decode(md5(n::text)||md5('hash_'||n),'hex'),'fixture.invalid',decode(repeat(md5('fixture.invalid'),2),'hex'),
    0,'SUCCEEDED','${month}'::timestamptz,'${month}'::timestamptz,'${month}'::timestamptz,'${month}'::timestamptz
    FROM generate_series(${start},${Math.min(count, start + batch - 1)}) n;`;
}

export function seedEvents(count, start = 1, batch = count) {
  assert(Number.isInteger(start) && start >= 1 && start <= count && Number.isInteger(batch) && batch > 0);
  return `INSERT INTO outbox_events(message_id,aggregate_type,aggregate_id,aggregate_version,event_type,
    contract_version,correlation_id,payload,status,available_at,delivered_at,created_at)
    SELECT md5('event_'||n)::uuid,'SCAN',md5('aggregate_'||((n-1)/1000))::uuid,n,'SCAN_PROGRESS_V1',1,
    md5('correlation_'||n)::uuid,jsonb_build_object('synthetic',repeat(md5(n::text),16)),
    'DELIVERED',now(),now(),now() FROM generate_series(${start},${Math.min(count, start + batch - 1)}) n;`;
}

export function restorePageSQL(target) {
  // Future-partition fixtures must respect the existing completion timestamp constraint.
  return `UPDATE scan_pages SET status='SUCCEEDED',pending_terminal_status=NULL,
    completed_at=greatest(discovered_at,clock_timestamp()) WHERE ${target}`;
}

function writeSQL(kind, round) {
  const execution = "md5('execution_2026-09-01_0')::uuid";
  const body = kind === 'pages' ? `
    UPDATE crawl_executions SET status='RUNNING',finished_at=NULL,leased_count=1000,succeeded_count=0 WHERE id=${execution};
    UPDATE scan_pages SET status='LEASED',lease_owner=md5('lease')::uuid,lease_expires_at=now()+interval '1 minute',
      attempt_count=1,completed_at=NULL WHERE retention_month='2026-09-01' AND execution_id=${execution};
    UPDATE scan_pages SET status='PERSISTING',pending_terminal_status='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL
      WHERE retention_month='2026-09-01' AND execution_id=${execution};
    UPDATE crawl_executions SET leased_count=0,persisting_count=1000 WHERE id=${execution};
    UPDATE scan_pages SET status='SUCCEEDED',pending_terminal_status=NULL,completed_at=now()
      WHERE retention_month='2026-09-01' AND execution_id=${execution};
    UPDATE crawl_executions SET status='COMPLETED',finished_at=now(),persisting_count=0,succeeded_count=1000 WHERE id=${execution};`
    : `INSERT INTO outbox_events(message_id,aggregate_type,aggregate_id,aggregate_version,event_type,
      contract_version,correlation_id,payload,status,available_at,created_at)
      SELECT md5('write_${round}_'||n)::uuid,'PROBE',md5('write_${round}_'||n)::uuid,1,'SCAN_PROGRESS_V1',1,
      md5('write_correlation')::uuid,'{"synthetic":true}','PENDING',now(),now() FROM generate_series(1,1000) n;
      UPDATE outbox_events SET status='CLAIMED',lease_owner=md5('lease')::uuid,lease_expires_at=now()+interval '1 minute'
        WHERE aggregate_type='PROBE' AND delivered_at IS NULL;
      UPDATE outbox_events SET status='DEAD',lease_owner=NULL,lease_expires_at=NULL
        WHERE aggregate_type='PROBE' AND delivered_at IS NULL;
      UPDATE outbox_events SET status='DELIVERED',delivered_at=now()
        WHERE aggregate_type='PROBE' AND delivered_at IS NULL;`;
  return `DO $probe$ DECLARE started timestamptz:=clock_timestamp(); lsn pg_lsn:=pg_current_wal_insert_lsn(); BEGIN
    ${body}
    RAISE NOTICE 'RECOVERY_WRITE|%',json_build_object('elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000,
      'walBytes',pg_wal_lsn_diff(pg_current_wal_insert_lsn(),lsn),'rows',1000);
    END $probe$;`;
}

export async function main(argv) {
  const { options } = parseCommandLine(['probe', ...argv]);
  assertKnownOptions(options, new Set(['profile', 'help']));
  if (flag(options, 'help')) { console.log('node tools/load/recovery-index-probe.mjs --profile smoke|representative\nLocal Docker only; synthetic twin databases; no production deployment.'); return; }
  const profile = stringOption(options, 'profile', 'smoke'), counts = profileFor(profile);
  assertLocalDockerHost(process.env.DOCKER_HOST);
  const contexts = JSON.parse((await run('docker', ['context', 'inspect'])).stdout);
  assert.equal(contexts.length, 1);
  const context = contexts[0];
  assert(context.Endpoints.docker.Host);
  assertLocalDockerHost(context.Endpoints.docker.Host);
  const disk = await statfs(repo);
  assert(disk.bavail * disk.bsize >= (profile === 'representative' ? 20 : 5) * 1024 ** 3, 'Insufficient local disk headroom');
  assert(os.freemem() >= 3 * 1024 ** 3, 'Insufficient local RAM headroom');
  const id = randomUUID(), output = path.join(repo, 'tmp/load', `recovery-index-${id}`);
  const snapshot = path.join(output, 'source');
  await mkdir(snapshot, { recursive: true });
  const source = await hashes(path.join(repo, 'crawler'));
  for (const name of ['cmd', 'internal', 'migrations', 'go.mod', 'go.sum'])
    await cp(path.join(repo, 'crawler', name), path.join(snapshot, name), { recursive: true });
  assert.deepEqual(await hashes(snapshot), source);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CRAWLER_|WEBLENS_|PG|GOOS$|GOARCH$|GOFLAGS$)/i.test(key)));
  const manifest = { id, profile, counts, scope: 'LOCAL_SYNTHETIC_INDEX_EXPERIMENT', releaseEligible: false,
    createdAt: new Date().toISOString(), source, sourceDigest: sha(JSON.stringify(source)), runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    host: { platform: os.platform(), cpus: os.cpus().length, totalMemory: os.totalmem() },
    limitations: ['Linux PG on Windows Docker, not VPS', 'Synthetic payload/cardinality, no full worker/API',
      'Warm read samples, first sample separately retained; no controlled OS cold cache', 'Sequential writes, no concurrent workload',
      'SQL status churn excludes full publish/ACK/lease/analytics workflow', 'Global WAL delta includes any background WAL; excludes commit record',
      'Autovacuum disabled only on owned test server for repeatability',
      'Host not reserved; no continuous host/container telemetry; timings exploratory, not regression acceptance',
      'Fixture setup commits bounded batches; baseline/candidate seeded independently'] };
  const runner = path.join(output, 'runner');
  await mkdir(runner);
  for (const name of ['recovery-index-probe.mjs', 'recovery-index-probe.test.mjs', 'local-admission-probe.mjs', 'lib'])
    await cp(path.join(repo, 'tools/load', name), path.join(runner, name), { recursive: true });
  await json(path.join(output, 'manifest.json'), manifest);
  console.log(`Evidence: ${output}\nBuilding source-snapshot migration CLI...`);
  const binary = path.join(output, process.platform === 'win32' ? 'crawler.exe' : 'crawler');
  const build = await run('go', ['build', '-trimpath', '-o', binary, './cmd/weblens-crawler'], { cwd: snapshot, env: cleanEnv });
  await writeFile(path.join(output, 'build.log'), build.stdout + build.stderr, { flag: 'wx' });
  assert.deepEqual(await hashes(snapshot), source);
  let container;
  const results = {};
  let outcome = 'FAILED';
  try {
    container = (await run('docker', ['run', '-d', '--label', `weblens.recovery-index-probe=${id}`,
      '--memory', '1536m', '--cpus', '2', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD',
      '-e', 'POSTGRES_USER=weblens_probe', 'postgres:17.11-alpine', '-c', 'autovacuum=off'],
    { env: { ...cleanEnv, POSTGRES_PASSWORD: randomBytes(24).toString('hex') } })).stdout.trim();
    assert(/^[0-9a-f]{64}$/.test(container));
    const details = JSON.parse((await run('docker', ['inspect', container])).stdout)[0];
    const binding = details.NetworkSettings.Ports['5432/tcp'][0];
    assert.equal(binding.HostIp, '127.0.0.1');
    const password = details.Config.Env.find(value => value.startsWith('POSTGRES_PASSWORD=')).slice('POSTGRES_PASSWORD='.length);
    await json(path.join(output, 'runtime.json'), { image: 'postgres:17.11-alpine', imageId: details.Image, container,
      port: +binding.HostPort, memory: '1536m', cpus: 2, binarySha256: sha(await readFile(binary)) });
    for (let attempt = 0; ; attempt++) {
      // The image's temporary initialization server accepts sockets before its final TCP server starts.
      try { await run('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'weblens_probe']); break; }
      catch { if (attempt >= 30) throw new Error('Test PostgreSQL not ready'); await delay(1000); }
    }
    async function sql(database, input, timeout = 2000, allowed = [0]) {
      return run('docker', ['exec', '-i', '-e', `PGOPTIONS=-c statement_timeout=${timeout} -c lock_timeout=500`,
        container, 'psql', '-h', '127.0.0.1', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-U', 'weblens_probe', '-d', database],
      { input, allowed, timeout: timeout + 15000, safeDiagnostic: true });
    }
    async function value(db, input, timeout = 2000) { return JSON.parse((await sql(db, input, timeout)).stdout.trim()); }
    const partitions = ['scan_pages_2026_09', 'scan_pages_2026_10', 'scan_pages_2026_11', 'scan_pages_2026_12',
      'scan_pages_2027_01', 'scan_pages_2027_02', 'scan_pages_2027_03', 'scan_pages_default'];
    for (const mode of ['before', 'after']) {
      const db = `weblens_recovery_${mode}`;
      console.log(`${mode}: migrate and seed ${counts.september + counts.october} pages / ${counts.events} events...`);
      await sql('postgres', `CREATE DATABASE ${db}`, 10000);
      const migration = await run(binary, ['migrate-postgres'], { env: { ...cleanEnv,
        CRAWLER_POSTGRES_URL: `postgres://weblens_probe:${password}@127.0.0.1:${binding.HostPort}/${db}?sslmode=disable&connect_timeout=5`,
        CRAWLER_SERVICE_TOKEN: randomBytes(32).toString('hex') } });
      await writeFile(path.join(output, `migration-${mode}.log`), migration.stdout + migration.stderr, { flag: 'wx' });
      for (const [month, count] of [['2026-09-01', counts.september], ['2026-10-01', counts.october]]) {
        results.phase = `${mode}: seed pages ${month}`;
        for (let start = 1; start <= count; start += 50000) await sql(db, seedPages(month, count, start, 50000), 180000);
      }
      results.phase = `${mode}: seed events`;
      for (let start = 1; start <= counts.events; start += 100000) await sql(db, seedEvents(counts.events, start, 100000), 180000);
      const cardinality = await value(db, `SELECT json_build_object('pages',(SELECT count(*) FROM scan_pages),'events',(SELECT count(*) FROM outbox_events))`, 30000);
      assert.deepEqual(cardinality, { pages: counts.september + counts.october, events: counts.events });
      results.phase = `${mode}: analyze`;
      await sql(db, 'ANALYZE scan_pages; ANALYZE outbox_events;', 180000);
      const history = await value(db, "SELECT json_agg(row_to_json(r)) FROM (SELECT version,checksum_sha256 FROM crawler_schema_history ORDER BY version) r");
      assert.equal(history.length, 6);
      const result = { history, cardinality, builds: [], reads: {}, writes: {} };
      results[mode] = result;
      if (mode === 'after') {
        results.phase = `${mode}: index builds`;
        const steps = indexSteps(partitions);
        for (let step = 0; step < steps.length; step++) {
          const started = performance.now();
          await sql(db, steps[step], 180000);
          result.builds.push({ sql: steps[step], elapsedMs: performance.now() - started });
          if (step === 1) assert.equal(await value(db, `SELECT to_json(indisvalid) FROM pg_index WHERE indexrelid='${parent}'::regclass`), false);
        }
      }
      for (const [scope, select] of Object.entries(query)) {
        results.phase = `${mode}: read ${scope}`;
        const estimatedPlan = (await value(db, `EXPLAIN (FORMAT JSON) ${select}`))[0];
        const samples = [];
        for (let round = 0; round < 12; round++) {
          const raw = await sql(db, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${select}`, 2000, mode === 'before' ? [0, 3] : [0]);
          const timeout = baselineReadTimeout(mode, raw.code, raw.stderr);
          if (timeout) {
            result.reads[scope] = { ...timeout, estimatedPlan, samples, attempts: round + 1 };
            console.log(`${mode}: ${scope} lookup TIMEOUT at 2000ms; no boolean/percentile proof`);
            break;
          }
          const plan = JSON.parse(raw.stdout.trim())[0];
          if (mode === 'after') assertSelectivePlan(plan, scope, scope === 'pages' ? partitions : ['outbox_events'],
            scope === 'pages' ? ['scan_pages_2026_09', 'scan_pages_2026_10'] : ['outbox_events']);
          samples.push(plan);
        }
        if (!result.reads[scope]) {
          result.reads[scope] = { outcome: 'MEASURED', estimatedPlan, samples, executionMs: summarize(samples.map(plan => plan['Execution Time'])) };
          assert.equal(await value(db, `SELECT to_json((${select}))`), false);
        }
      }
      for (const kind of ['pages', 'events']) {
        results.phase = `${mode}: write ${kind}`;
        const samples = [];
        for (let round = 0; round < 20; round++) samples.push(timedNotice((await sql(db, writeSQL(kind, round), 30000)).stderr));
        result.writes[kind] = { samples, elapsedMs: summarize(samples.map(row => row.elapsedMs)), walBytes: summarize(samples.map(row => row.walBytes)) };
      }
      result.sizes = await value(db, `SELECT json_build_object('pages',pg_total_relation_size('scan_pages_2026_09')+pg_total_relation_size('scan_pages_2026_10'),
        'events',pg_total_relation_size('outbox_events'))`);
      if (mode === 'after') {
        results.phase = `${mode}: functional/negative checks`;
        await sql(db, seedPages('2027-05-01', 1));
        await sql(db, "CREATE TABLE scan_pages_2027_04 PARTITION OF scan_pages FOR VALUES FROM ('2027-04-01') TO ('2027-05-01')", 10000);
        await sql(db, seedPages('2027-04-01', 1));
        partitions.push('scan_pages_2027_04');
        for (const month of ['2026-09-01', '2026-10-01', '2027-04-01', '2027-05-01']) {
          const target = `retention_month='${month}' AND id=md5('page_${month}_1')::uuid`;
          const change = `UPDATE scan_pages SET status='PERSISTING',pending_terminal_status='SUCCEEDED',completed_at=NULL WHERE ${target}`;
          await sql(db, `BEGIN; ${change}; ROLLBACK;`);
          assert.equal(await value(db, `SELECT to_json((${query.pages}))`), false);
          await sql(db, change);
          assert.equal(await value(db, `SELECT to_json((${query.pages}))`), true, 'Orphan outside active execution was missed');
          if (month === '2027-04-01') {
            const invalidFixture = await sql(db, `UPDATE scan_pages SET status='SUCCEEDED',pending_terminal_status=NULL,completed_at=discovered_at-interval '1 second' WHERE ${target}`, 2000, [3]);
            assert(/23514/.test(invalidFixture.stderr) && /ck_scan_pages_timestamps/.test(invalidFixture.stderr));
            result.fixtureConstraintCheck = { sqlstate: '23514', constraint: 'ck_scan_pages_timestamps', rejected: true };
          }
          await sql(db, restorePageSQL(target));
        }
        const event = "message_id=md5('event_1')::uuid";
        await sql(db, `BEGIN; UPDATE outbox_events SET status='DEAD',delivered_at=NULL WHERE ${event}; ROLLBACK;`);
        assert.equal(await value(db, `SELECT to_json((${query.events}))`), false);
        await sql(db, `UPDATE outbox_events SET status='DEAD',delivered_at=NULL WHERE ${event}`);
        assert.equal(await value(db, `SELECT to_json((${query.events}))`), true);
        await sql(db, `UPDATE outbox_events SET status='DELIVERED',delivered_at=now() WHERE ${event}`);
        const timeout = await sql(db, 'SELECT pg_sleep(.1)', 1, [3]);
        assert(/57014/.test(timeout.stderr), 'Timeout must remain an error, not false');
        const coverage = await value(db, `SELECT json_agg(row_to_json(r)) FROM (SELECT CASE WHEN c.relname='${eventIndex}' THEN 'event'
          WHEN c.relname='${parent}' THEN 'parent' ELSE 'leaf' END AS kind,t.relname AS table,c.relname AS name,
          i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indisunique AS unique,
          am.amname AS method,i.indnatts AS "attributeCount",pg_get_indexdef(c.oid,1,true) AS columns,
          pg_get_expr(i.indpred,i.indrelid) AS predicate,p.relname AS parent,pg_relation_size(c.oid) AS bytes
          FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
          JOIN pg_am am ON c.relam=am.oid LEFT JOIN pg_inherits inh ON inh.inhrelid=c.oid
          LEFT JOIN pg_class p ON p.oid=inh.inhparent
          WHERE c.relname='${eventIndex}' OR c.relname='${parent}' OR inh.inhparent='${parent}'::regclass) r`);
        assertCoverage(coverage, partitions);
        result.coverage = coverage;
        result.functionalChecks = ['absent/present', 'terminal orphan across months/default/new partition', 'rollback invisible',
          'DEAD transition', 'timeout SQLSTATE57014 is not false', 'invalid parent until all leaves attached', 'new partition auto-index'];
        // Exercise failure/recovery after timing samples so these operations cannot distort the comparison.
        async function withHeldTransaction(body, check) {
          const holding = sql(db, `BEGIN; ${body}; SELECT pg_advisory_xact_lock(91903811); SELECT pg_sleep(4); ROLLBACK;`, 10000)
            .then(value => ({ value }), error => ({ error }));
          try {
            let ready = false;
            for (let attempt = 0; attempt < 40; attempt++) {
              ready = await value(db, "SELECT to_json(EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=91903811 AND granted))");
              if (ready) break;
              await delay(50);
            }
            assert(ready, 'Fault fixture did not acquire its lock');
            await check();
          } finally {
            const finished = await holding;
            if (finished.error) throw finished.error;
          }
        }
        result.negativeChecks = [];
        results.phase = `${mode}: interrupted concurrent build`;
        await withHeldTransaction(`UPDATE outbox_events SET created_at=created_at WHERE ${event}`, async () => {
          const failed = await sql(db, "CREATE INDEX CONCURRENTLY ix_probe_interrupted_dead ON outbox_events(message_id) WHERE status='DEAD'", 10000, [3]);
          assert(/55P03/.test(failed.stderr), 'Build lock timeout must be observable');
          assert.equal(await value(db, "SELECT to_json(indisvalid) FROM pg_index WHERE indexrelid='ix_probe_interrupted_dead'::regclass"), false);
        });
        results.phase = `${mode}: invalid index cleanup`;
        await sql(db, 'DROP INDEX CONCURRENTLY ix_probe_interrupted_dead', 10000);
        assert.equal(await value(db, "SELECT to_json(to_regclass('ix_probe_interrupted_dead') IS NULL)"), true);
        result.negativeChecks.push('writer lock -> concurrent build SQLSTATE55P03 -> invalid index -> concurrent cleanup');
        results.phase = `${mode}: blocked parent rollback`;
        await withHeldTransaction('LOCK TABLE ONLY scan_pages IN ACCESS SHARE MODE', async () => {
          const blockedDrop = await sql(db, `DROP INDEX ${parent}`, 10000, [3]);
          assert(/55P03/.test(blockedDrop.stderr), 'Parent rollback must respect lock timeout');
          assert.equal(await value(db, `SELECT to_json(indisvalid) FROM pg_index WHERE indexrelid='${parent}'::regclass`), true);
        });
        result.negativeChecks.push('reader lock -> parent DROP SQLSTATE55P03 -> valid index preserved');
        results.phase = `${mode}: drained rollback`;
        await sql(db, `DROP INDEX ${parent}`, 10000);
        await sql(db, `DROP INDEX CONCURRENTLY ${eventIndex}`, 10000);
        assert.equal(await value(db, `SELECT to_json(to_regclass('${parent}') IS NULL AND to_regclass('${eventIndex}') IS NULL)`), true);
        result.negativeChecks.push('drained parent/event rollback -> no candidate indexes');
        result.rollbackReads = {};
        for (const [scope, select] of Object.entries(query)) {
          results.phase = `${mode}: post-rollback read ${scope}`;
          const raw = await sql(db, `SELECT to_json((${select}))`, 2000, [0, 3]);
          // Removing the candidate restores the slow baseline path; TIMEOUT remains unknown, never false.
          const timeout = baselineReadTimeout('before', raw.code, raw.stderr);
          if (timeout) result.rollbackReads[scope] = timeout;
          else {
            assert.equal(JSON.parse(raw.stdout.trim()), false);
            result.rollbackReads[scope] = { outcome: 'MEASURED', value: false };
          }
        }
        results.phase = `${mode}: post-rollback fixture invariants`;
        for (const month of ['2026-09-01', '2026-10-01', '2027-04-01', '2027-05-01'])
          assert.equal(await value(db, `SELECT to_json(status='SUCCEEDED' AND pending_terminal_status IS NULL) FROM scan_pages WHERE retention_month='${month}' AND id=md5('page_${month}_1')::uuid`), true);
        assert.equal(await value(db, `SELECT to_json(status='DELIVERED') FROM outbox_events WHERE ${event}`), true);
        result.negativeChecks.push('post-rollback target fixtures unchanged; global timeout remains UNKNOWN');
        assert.deepEqual(await value(db, "SELECT json_agg(row_to_json(r)) FROM (SELECT version,checksum_sha256 FROM crawler_schema_history ORDER BY version) r"), history);
      }
      await json(path.join(output, `${mode}.json`), result);
      console.log(`${mode}: reads pages p95=${result.reads.pages.executionMs?.p95 ?? 'TIMEOUT'}ms / events p95=${result.reads.events.executionMs?.p95 ?? 'TIMEOUT'}ms`);
    }
    assert.deepEqual(results.before.history, results.after.history);
    assert.deepEqual(await hashes(snapshot), source);
    results.phase = 'complete';
    outcome = Object.values(results.before.reads).some(read => read.outcome === 'TIMEOUT')
      ? 'COMPLETED_WITH_BASELINE_TIMEOUT' : 'PASS';
  } catch (error) {
    results.failure = { message: error.message };
    throw error;
  } finally {
    let removed = !container;
    if (container) {
      const details = JSON.parse((await run('docker', ['inspect', container])).stdout)[0];
      assert.equal(details.Config.Labels['weblens.recovery-index-probe'], id, 'Ownership mismatch; refusing cleanup');
      results.containerState = { status: details.State.Status, exitCode: details.State.ExitCode, oomKilled: details.State.OOMKilled };
      await run('docker', ['rm', '-f', '-v', container]);
      removed = true;
    }
    await json(path.join(output, 'final.json'), { outcome, removed, results, finishedAt: new Date().toISOString() });
    console.log(`Outcome ${outcome}; owned temporary databases removed; evidence retained: ${output}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
