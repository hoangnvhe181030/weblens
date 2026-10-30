#!/usr/bin/env node
// Off-host PG-only restore and index rehearsal. Never connects to production or starts workers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertKnownOptions, parseCommandLine, stringOption } from './lib/cli.mjs';
import { assertLocalDockerHost } from './local-admission-probe.mjs';
import { assertCoverage, assertSelectivePlan, indexSteps } from './recovery-index-probe.mjs';

const image = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const databases = ['weblens', 'weblens_crawler', 'weblens_capture'];
const approvedRunbookSha256 = 'abf1b4b81a22d1286b33cab4bd48517c97ce453af3fcc468b797cb7761151ec7';
const archiveHashes = ['13aa5e3f297bf6ef1f40ff6b2d5b161514098464a01ad34823536efded29a781',
  'e50945d767ec545d764da6619fcee6d9ba767f83b5ea561728036071efc7ee73',
  '9999b715f4d9532b7a389b60084b52157b5729c1ab626ee9ed519ea88c40f0ad'];
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.databases.length, 3);
  assert.deepEqual(manifest.databases.map(row => row.database), databases);
  manifest.databases.forEach((row, i) => {
    assert.equal(row.sha256, archiveHashes[i], 'Not the approved fresh backup');
    assert(Number.isSafeInteger(row.bytes) && row.bytes > 0);
    assert(Number.isSafeInteger(row.tocEntries) && row.tocEntries > 0);
  });
}

export function validateContainer(details, id, backupDir) {
  assert.equal(details.Config.Labels['weblens.recovery-restore-drill'], id);
  assert.equal(details.Image, image);
  assert.equal(details.HostConfig.NetworkMode, 'none');
  assert.deepEqual(details.HostConfig.PortBindings || {}, {});
  assert.equal(details.HostConfig.Memory, 1536 * 1024 ** 2);
  assert.equal(details.HostConfig.NanoCpus, 2 * 1e9);
  assert(!details.HostConfig.Privileged);
  const mounts = details.Mounts.filter(row => row.Type === 'bind');
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].Destination, '/backup');
  assert.equal(mounts[0].RW, false);
  assert.equal(mounts[0].Source.replaceAll('\\', '/').toLowerCase(), backupDir.replaceAll('\\', '/').toLowerCase());
}

export function tocObjects(toc) {
  const entries = toc.split(/\r?\n/).filter(row => row.trim() && !row.startsWith(';'));
  const names = type => entries.filter(row => row.includes(` ${type} public `)).map(row => {
    const name = row.split(` ${type} public `)[1].split(' ')[0];
    assert(/^[a-z][a-z0-9_]{0,62}$/.test(name), 'Unexpected archive object name');
    return name;
  });
  return { entries: entries.length, tables: names('TABLE'), indexes: names('INDEX'), sequences: names('SEQUENCE') };
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

function run(command, args, { input, env = process.env, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Local tool launch failed')); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function main(argv) {
  const { options } = parseCommandLine(['drill', ...argv]);
  assertKnownOptions(options, new Set(['backup-dir']));
  assert.equal(process.platform, 'win32', 'This drill validates NTFS ACLs');
  const requested = stringOption(options, 'backup-dir');
  assert(requested && path.isAbsolute(requested), 'Absolute private backup directory required');
  const backupDir = await realpath(requested);
  const privateRoot = path.dirname(backupDir);
  assert.equal(path.dirname(privateRoot).toLowerCase(), os.homedir().toLowerCase());
  assert(/^weblens-private-recovery-20261009-[a-f0-9]{32}$/.test(path.basename(privateRoot)));
  assert.equal(path.basename(backupDir), 'performance-preflight-20261009T055416Z');
  assert(!(await lstat(requested)).isSymbolicLink());
  // PS7's inherited module path prevents Windows PowerShell 5 from loading its native ACL module.
  const aclEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const acl = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($sid,'S-1-5-18','S-1-5-32-544'); $root=$env:WEBLENS_PRIVATE_DRILL_ROOT; foreach($p in @((Get-Item -LiteralPath $root))+@(Get-ChildItem -LiteralPath $root -Recurse -Force)){ if($p.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point'}; foreach($a in (Get-Acl -LiteralPath $p.FullName).Access){if($a.AccessControlType -ne 'Allow' -or $a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Unsafe private ACL'}} }; 'PRIVATE_ACL_PASS'"],
    { env: { ...aclEnv, WEBLENS_PRIVATE_DRILL_ROOT: privateRoot } });
  assert.equal(acl.code, 0, 'Private ACL preflight failed');
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  validateManifest(manifest);
  for (const row of manifest.databases) {
    const file = path.join(backupDir, `${row.database}.dump`);
    assert.equal((await lstat(file)).size, row.bytes);
    assert.equal(await fileHash(file), row.sha256, 'Off-host archive mismatch');
  }
  assertLocalDockerHost(process.env.DOCKER_HOST);
  const context = JSON.parse((await run('docker', ['context', 'inspect'])).stdout);
  assert.equal(context.length, 1);
  assertLocalDockerHost(context[0].Endpoints.docker.Host);
  const disk = await statfs(privateRoot);
  assert(disk.bavail * disk.bsize >= 20 * 1024 ** 3 && os.freemem() >= 3 * 1024 ** 3, 'Local resource guard failed');
  const id = randomUUID(), output = path.join(privateRoot, `drill-${id}`);
  await mkdir(output);
  await writeFile(path.join(output, 'runner-source.mjs'), await readFile(fileURLToPath(import.meta.url)), { flag: 'wx' });
  const evidence = { id, createdAtUtc: new Date().toISOString(), scope: 'ISOLATED_POSTGRES_ONLY',
    approvedRunbookSha256, runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    backupManifestSha256: await fileHash(path.join(backupDir, 'manifest.json')), manifest,
    image, databases: {}, builds: [], samples: [], removed: false, productionDdlExecuted: false,
    limitations: ['No workers, Redis, ClickHouse or R2 restore; no session activation',
      'No role/ACL/global restore (--no-owner --no-acl); three independent dump snapshots',
      'Autovacuum disabled only on the owned restore server; ANALYZE run explicitly',
      'Linux Docker, not Windows production; sampled peaks may miss spikes; no concurrent writes; WAL includes background',
      'Local restore durations are not full-stack production RTO; host not reserved'] };
  let container, phase = 'create container', serial = 0;
  const execute = async (args, config = {}) => {
    const result = await run('docker', args, config);
    await save(path.join(output, `command-${++serial}.json`), result);
    assert(!result.timedOut && result.code === 0, `Drill command failed in ${phase}; details retained privately`);
    return result.stdout;
  };
  try {
    container = (await execute(['run', '-d', '--label', `weblens.recovery-restore-drill=${id}`, '--network', 'none',
      '--memory', '1536m', '--cpus', '2', '--mount', `type=bind,source=${backupDir},target=/backup,readonly`,
      '-e', 'POSTGRES_PASSWORD', image, '-c', 'autovacuum=off'], { env: { ...process.env, POSTGRES_PASSWORD: randomBytes(24).toString('hex') } })).trim();
    assert(/^[a-f0-9]{64}$/.test(container));
    // Inspect contains initialization credentials: validate in memory, never save raw inspect output.
    const inspect = async () => JSON.parse((await run('docker', ['inspect', container])).stdout)[0];
    validateContainer(await inspect(), id, backupDir);
    evidence.container = container;
    for (let attempt = 0; ; attempt++) {
      const ready = await run('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      if (ready.code === 0) break;
      assert(attempt < 30, 'Isolated PostgreSQL not ready');
      await delay(1000);
    }
    const sql = async (db, statement, timeout = 2000) => execute(['exec', '-i', '-e',
      `PGOPTIONS=-c statement_timeout=${timeout} -c lock_timeout=500 -c maintenance_work_mem=65536`, container,
      'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'],
    { input: statement, timeout: timeout + 15000 });
    const value = async (db, statement, timeout) => JSON.parse((await sql(db, statement, timeout)).trim());
    assert.equal(await value('postgres', "SELECT to_json(current_setting('server_version'))"), '17.11');
    for (const db of databases) {
      phase = `restore ${db}`;
      console.log(`${phase} (isolated; logs private)`);
      const toc = await execute(['exec', container, 'pg_restore', '--list', `/backup/${db}.dump`]);
      const objects = tocObjects(toc);
      assert.equal(objects.entries, manifest.databases.find(row => row.database === db).tocEntries);
      await execute(['exec', container, 'createdb', '-U', 'postgres', db]);
      const started = performance.now();
      await execute(['exec', container, 'pg_restore', '-U', 'postgres', '--exit-on-error', '--no-owner', '--no-acl',
        '--dbname', db, `/backup/${db}.dump`], { timeout: 1800000 });
      const restoreMs = performance.now() - started;
      phase = `catalog ${db}`;
      const catalog = await value(db, `SELECT json_build_object(
        'tables',(SELECT json_agg(relname ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')),
        'indexes',(SELECT json_agg(relname ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('i','I')),
        'invalidIndexes',(SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready OR NOT indislive),
        'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated),
        'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),
        'sequences',(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S'))`);
      assert.deepEqual(catalog.tables, objects.tables.sort());
      assert(objects.indexes.every(name => catalog.indexes.includes(name)));
      assert.equal(catalog.invalidIndexes, 0); assert.equal(catalog.unvalidatedConstraints, 0);
      // This pinned backup has UUID keys and no sequences. Fail rather than claim untested sequence state.
      assert.equal(objects.sequences.length, 0); assert.equal(catalog.sequences, 0);
      const historyTable = db === 'weblens' ? 'flyway_schema_history' : db === 'weblens_crawler' ? 'crawler_schema_history' : 'capture_schema_migrations';
      const history = await value(db, `SELECT coalesce(json_agg(row_to_json(r)),'[]'::json) FROM (SELECT * FROM ${historyTable} ORDER BY ${db === 'weblens' ? 'installed_rank' : 'version'}) r`);
      assert(history.length > 0);
      if (db === 'weblens') assert(history.every(row => row.success === true));
      evidence.databases[db] = { outcome: 'RESTORED', restoreMs, catalog, history, tocSha256: sha(toc) };
      await save(path.join(output, `${db}-restored.json`), evidence.databases[db]);
      phase = `analyze ${db}`;
      await sql(db, 'ANALYZE;', 180000);
      evidence.databases[db].analyzed = true;
      console.log(`${db}: restore/catalog/analyze completed`);
    }
    phase = 'auth ledger invariants';
    const auth = await value('weblens', `SELECT json_build_object('sessions',(SELECT count(*) FROM auth_sessions),
      'orphanSessions',(SELECT count(*) FROM auth_sessions a LEFT JOIN users u ON u.id=a.user_id WHERE u.id IS NULL),
      'invalidHashes',(SELECT count(*) FROM auth_sessions WHERE refresh_jti_hash !~ '^[0-9a-f]{64}$' OR csrf_token_hash !~ '^[0-9a-f]{64}$'),
      'duplicateRefreshHashes',(SELECT count(*) FROM (SELECT refresh_jti_hash FROM auth_sessions GROUP BY refresh_jti_hash HAVING count(*)>1) r),
      'invalidTimestamps',(SELECT count(*) FROM auth_sessions WHERE expires_at<=created_at OR revoked_at<created_at OR rotated_at<created_at))`, 30000);
    for (const key of ['orphanSessions','invalidHashes','duplicateRefreshHashes','invalidTimestamps']) assert.equal(auth[key], 0);
    evidence.authLedger = auth;
    const db = 'weblens_crawler';
    phase = 'real predicate density';
    evidence.density = await value(db, `SELECT json_build_object(
      'pages',(SELECT count(*) FROM scan_pages),'persisting',(SELECT count(*) FROM scan_pages WHERE status='PERSISTING'),
      'events',(SELECT count(*) FROM outbox_events),'dead',(SELECT count(*) FROM outbox_events WHERE status='DEAD'))`, 180000);
    const partitions = await value(db, "SELECT json_agg(relid::regclass::text ORDER BY relid::regclass::text) FROM pg_partition_tree('public.scan_pages') WHERE isleaf AND level=1");
    assert(partitions.length === 8 && partitions.includes('scan_pages_default'));
    const steps = indexSteps(partitions);
    evidence.ddlSha256 = sha(steps.join(';\n') + ';\n');
    await writeFile(path.join(output, 'rehearsal.sql'), steps.join(';\n') + ';\n', { flag: 'wx' });
    const resource = async () => {
      const pg = await value(db, `SELECT json_build_object('lsn',pg_current_wal_insert_lsn()::text,
        'databaseBytes',pg_database_size(current_database()),'tempBytes',(SELECT temp_bytes FROM pg_stat_database WHERE datname=current_database()),
        'tempFilesBytes',(SELECT coalesce(sum(size),0) FROM pg_ls_tmpdir()),'walFilesBytes',(SELECT coalesce(sum(size),0) FROM pg_ls_waldir()))`);
      const stats = JSON.parse(await execute(['stats', '--no-stream', '--format', '{{json .}}', container]));
      const disk = await statfs(privateRoot);
      return { utc: new Date().toISOString(), phase, pg, cpu: stats.CPUPerc, memory: stats.MemUsage,
        memoryPercent: stats.MemPerc, blockIO: stats.BlockIO, localFreeDiskBytes: disk.bavail * disk.bsize };
    };
    for (const statement of steps) {
      phase = `rehearsal build ${evidence.builds.length + 1}/${steps.length}`;
      console.log(phase);
      const before = await resource(); evidence.samples.push(before);
      let stopped = false, monitorFailure;
      const monitor = (async () => {
        while (!stopped) {
          try { evidence.samples.push(await resource()); }
          catch { monitorFailure = true; break; }
          if (!stopped) await delay(1000);
        }
      })();
      const started = performance.now();
      let elapsedMs;
      try {
        await sql(db, statement, statement.startsWith('CREATE INDEX CONCURRENTLY') ? 180000 : 2000);
        elapsedMs = performance.now() - started;
      }
      finally { stopped = true; await monitor; }
      assert(!monitorFailure, 'Resource sampling failed');
      const after = await resource(); evidence.samples.push(after);
      const walBytes = await value(db, `SELECT to_json(pg_wal_lsn_diff('${after.pg.lsn}'::pg_lsn,'${before.pg.lsn}'::pg_lsn))`);
      evidence.builds.push({ statement, elapsedMs, walBytes, before, after });
      await save(path.join(output, `build-${evidence.builds.length}.json`), evidence.builds.at(-1));
    }
    phase = 'candidate catalog and proof';
    const coverage = await value(db, `SELECT json_agg(row_to_json(r)) FROM (
      SELECT CASE WHEN t.relname='outbox_events' THEN 'event' WHEN t.relname='scan_pages' THEN 'parent' ELSE 'leaf' END kind,
      t.relname "table",i.indisvalid valid,i.indisready ready,i.indislive live,i.indisunique "unique",a.amname method,
      i.indnatts "attributeCount",pg_get_indexdef(i.indexrelid,1,true) columns,pg_get_expr(i.indpred,i.indrelid) predicate,
      (SELECT p.relname FROM pg_inherits h JOIN pg_class p ON p.oid=h.inhparent WHERE h.inhrelid=i.indexrelid) parent,
      pg_relation_size(i.indexrelid) bytes
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am a ON a.oid=c.relam
      WHERE c.relname='ix_outbox_dead_recovery' OR c.relname='ix_scan_pages_persisting_recovery' OR c.relname LIKE 'scan_pages%_persisting_recovery') r`);
    assertCoverage(coverage, partitions); evidence.coverage = coverage;
    for (const [scope, table, predicate] of [['pages','scan_pages','PERSISTING'],['events','outbox_events','DEAD']]) {
      const statement = `SELECT EXISTS(SELECT 1 FROM ${table} WHERE status='${predicate}')`;
      const plan = (await value(db, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`))[0];
      const large = scope === 'events' ? ['outbox_events'] : partitions.filter(name => /2026_(09|10)$/.test(name));
      assertSelectivePlan(plan, scope, scope === 'events' ? ['outbox_events'] : partitions, large);
      const exists = await value(db, `SELECT to_json((${statement}))`);
      assert.equal(exists, evidence.density[scope === 'pages' ? 'persisting' : 'dead'] > 0);
      evidence[`${scope}Proof`] = { exists, plan };
    }
    const historyAfter = await value(db, 'SELECT coalesce(json_agg(row_to_json(r)),\'[]\'::json) FROM (SELECT * FROM crawler_schema_history ORDER BY version) r');
    assert.deepEqual(historyAfter, evidence.databases[db].history);
    evidence.outcome = 'PG_RESTORE_AND_INDEX_REHEARSAL_COMPLETED';
  } catch (error) {
    evidence.outcome = 'FAILED';
    evidence.failure = { phase, message: /Drill command failed/.test(error.message) ? error.message : 'Validation failed; inspect private evidence' };
    throw new Error(`Restore/rehearsal failed in ${phase}; private evidence: ${output}`);
  } finally {
    if (container) {
      try {
        const details = JSON.parse((await run('docker', ['inspect', container])).stdout)[0];
        // A failed isolation check must still clean up this owned container, not leave a data-bearing server.
        assert.equal(details.Id, container);
        assert.equal(details.Config.Labels['weblens.recovery-restore-drill'], id);
        evidence.oomKilled = details.State.OOMKilled;
        const removed = await run('docker', ['rm', '-f', '-v', container]);
        evidence.removed = removed.code === 0;
      } catch { evidence.cleanup = 'UNVERIFIED_OWNERSHIP_OR_REMOVAL'; }
    }
    evidence.finishedAtUtc = new Date().toISOString();
    await save(path.join(output, 'result.json'), evidence);
    console.log(JSON.stringify({ outcome: evidence.outcome, phase, removed: evidence.removed, evidence: output }));
    assert(evidence.removed && !evidence.oomKilled, 'Owned container cleanup/OOM guard failed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
