import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { main, tocObjects, validateContainer, validateManifest } from './recovery-index-restore-drill.mjs';

const hashes = ['13aa5e3f297bf6ef1f40ff6b2d5b161514098464a01ad34823536efded29a781',
  'e50945d767ec545d764da6619fcee6d9ba767f83b5ea561728036071efc7ee73',
  '9999b715f4d9532b7a389b60084b52157b5729c1ab626ee9ed519ea88c40f0ad'];
const manifest = () => ({ schemaVersion: 1, databases: ['weblens','weblens_crawler','weblens_capture']
  .map((database, i) => ({ database, sha256: hashes[i], bytes: 1, tocEntries: 1 })) });
const container = () => ({ Image: 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
  Config: { Labels: { 'weblens.recovery-restore-drill': 'owned' } },
  HostConfig: { NetworkMode: 'none', Memory: 1536 * 1024 ** 2, NanoCpus: 2e9, PortBindings: {}, Privileged: false },
  Mounts: [{ Type: 'bind', Destination: '/backup', RW: false, Source: 'C:/private' }] });

test('only the pinned fresh three-database manifest is accepted', () => {
  validateManifest(manifest());
  for (const mutate of [m => m.databases.pop(), m => m.databases.reverse(), m => m.schemaVersion++,
    m => m.databases[0].sha256 = '0'.repeat(64), m => m.databases[0].database = '../secret',
    m => m.databases[0].bytes = 0, m => m.databases[0].tocEntries = NaN]) {
    const m = manifest(); mutate(m); assert.throws(() => validateManifest(m));
  }
});

test('restore/cleanup refuse wrong ownership, network, ports, image or writable bind', () => {
  validateContainer(container(), 'owned', 'C:\\private');
  for (const mutate of [c => c.Config.Labels = {}, c => c.HostConfig.NetworkMode = 'bridge',
    c => c.HostConfig.PortBindings = { '5432/tcp': [{}] }, c => c.Mounts[0].RW = true,
    c => c.Mounts[0].Source = 'C:/other', c => c.HostConfig.Privileged = true,
    c => c.HostConfig.Memory = 0, c => c.Image = 'latest']) {
    const c = container(); mutate(c); assert.throws(() => validateContainer(c, 'owned', 'C:/private'));
  }
});

test('TOC distinguishes table/data/attach, constraint indexes and rejects unsafe names', () => {
  const objects = tocObjects('; header\n1; 2 3 TABLE public users owner\n2; 2 4 TABLE DATA public users owner\n3; 0 0 TABLE ATTACH public users owner\n4; 0 5 INDEX public ix_users owner\n5; 0 6 CONSTRAINT public users users_pkey owner\n');
  assert.deepEqual(objects, { entries: 5, tables: ['users'], indexes: ['ix_users'], sequences: [] });
  assert.throws(() => tocObjects('1; 2 3 TABLE public bad-name owner'));
});

test('unsafe CLI options fail without creating resources', async () => {
  await assert.rejects(main(['--target','https://jobnext.top']));
  await assert.rejects(main(['--skip-guards','yes']));
});

test('restore is isolated and bounded; logs private; inspect credentials are never persisted', async () => {
  const source = await readFile(new URL('./recovery-index-restore-drill.mjs', import.meta.url), 'utf8');
  assert(source.includes("'--exit-on-error', '--no-owner', '--no-acl'"));
  assert(!source.includes("'--clean'"));
  assert(source.includes("'--network', 'none'"));
  assert(source.includes("assert.equal(details.Id, container)"));
  assert(source.includes("assert.equal(details.Config.Labels['weblens.recovery-restore-drill'], id)"));
  assert(source.includes("timeout: 1800000"));
  assert(source.includes('PRIVATE_ACL_PASS'));
  assert(source.includes("image, '-c', 'autovacuum=off'"));
  assert(source.includes("'docker', ['inspect', container]"));
  assert(!source.includes("execute(['inspect'"));
});
