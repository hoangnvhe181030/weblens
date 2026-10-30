import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scanId = '018f0f00-0000-7000-8000-000000000002';
const samples = {};
const logs = [];
const calls = [];
let now = 0;
let response = { status: 0, error_code: 1050, timings: {
  duration: 0, blocked: 0, connecting: 1031, tls_handshaking: 0, sending: 0, waiting: 0, receiving: 0,
}, json() { throw Error('No HTTP response'); } };
class Metric {
  constructor(name) { this.name = name; samples[name] = []; }
  add(value) { samples[this.name].push(value); }
}
function load(name, extra) {
  const source = readFileSync(new URL(`./k6/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace('export default function', 'function scenario')
    .replace(/export /g, '');
  const context = vm.createContext({
    __ENV: { WEBLENS_SCAN_COUNT: '1', WEBLENS_PHASE5_LEVEL_ID: 'offline-1',
      WEBLENS_PHASE5_SEED_FILE: 'unused', WEBLENS_PHASE5_PASSWORD: 'private-password',
      WEBLENS_MIXED_VUS: '500', WEBLENS_ACK_HIGH_LOAD: '1', WEBLENS_MIXED_PASSWORD: 'private-password',
      ...extra.env },
    open: () => JSON.stringify(extra.seed), __VU: 1, __ITER: 0,
    Rate: Metric, Trend: Metric, Counter: Metric,
    Date: { now: () => now }, console: { log: (line) => logs.push(line) },
    check: () => {}, sleep: () => {},
    http: { post: (url, body, options) => {
      calls.push({ url, options }); now += 5004;
      return url.endsWith('/auth/sessions') ? { status: 200, json: () => 'private-token' } : response;
    },
      get: (url) => { calls.push({ url }); return { status: 200 }; } },
  });
  vm.runInContext(source, context);
  return context;
}
const admission = load('crawler-submit', { seed: { entries: [{ index: 0, accountIndex: 0, websiteId: 'site' }] } });
const admissionSummary = vm.runInContext('handleSummary({metrics:{count:1},state:{},setup_data:{tokens:{0:"private-token"}}})', admission);
assert.doesNotMatch(JSON.stringify(admissionSummary), /private-token|setup_data/);
vm.runInContext('scenario({tokens: {0: "private-token"}})', admission);
assert.deepEqual(samples.scan_admission_duration, []);
assert.deepEqual(samples.scan_admission_elapsed, [5004]);
assert.deepEqual(samples.scan_admission_failed, [true]);
assert.match(logs[0], /\|0\|0\|5004\|1050\|/);
assert.equal(calls[0].options.timeout, '5s');
assert.equal(calls[0].options.headers['X-Correlation-ID'], 'offline-1-admission-0');
assert.doesNotMatch(logs.join(''), /private-token|private-password|Authorization/);
response = { status: 202, timings: { duration: 100, blocked: 0, connecting: 0,
  tls_handshaking: 0, sending: 1, waiting: 98, receiving: 1 }, json: () => scanId };
vm.runInContext(`seed.entries[0].correlationId = '${scanId}'`, admission);
vm.runInContext('scenario({tokens: {0: "private-token"}})', admission);
assert.deepEqual(samples.scan_admission_duration, [100]);
assert.deepEqual(samples.scan_admission_failed, [true, false]);
assert.equal(calls.length, 2, 'Admission must issue exactly one POST per iteration');
assert.equal(calls[1].options.headers['X-Correlation-ID'], scanId, 'Persisted correlation UUID must reach Backend unchanged');
vm.runInContext('seed.entries[0].correlationId = "a".repeat(65)', admission);
assert.throws(() => vm.runInContext('setup()', admission), /Invalid admission correlation ID/);
const warm = load('crawler-submit', { seed: { entries: [{ index: 0, accountIndex: 0, websiteId: 'site' }] },
  env: { WEBLENS_ADMISSION_WARM_CONNECTION: '1', WEBLENS_ADMISSION_STAGGER_MS: '20' } });
const beforeWarm = calls.length;
vm.runInContext('scenario({tokens: {0: "private-token"}})', warm);
assert.equal(calls.length, beforeWarm + 2);
assert.match(calls.at(-2).url, /actuator\/health$/);
assert.equal(calls.at(-1).options.timeout, '5s');
warm.__ENV.WEBLENS_ADMISSION_WARM_CONNECTION = 'invalid';
assert.throws(() => vm.runInContext('setup()', warm), /Admission probe requires/);
calls.length = 0;

const users = Array.from({ length: 500 }, (_, i) => ({ email: `owner-${i}`, websiteId: `site-${i}`,
  scanId: i < 2 ? null : `018f0f00-0000-7000-8000-${String(i).padStart(12, '0')}` }));
const mixed = load('mixed-activity', { seed: { users }, env: { WEBLENS_MIXED_ALLOW_MISSING_SCAN: '1' } });
vm.runInContext('setup(); token = "private-token";', mixed);
assert.equal(calls.filter(({url}) => url.endsWith('/auth/sessions')).length, 500);
assert.doesNotMatch(logs.join(''), /private-token|private-password|Authorization/);
const safeSummary = vm.runInContext('handleSummary({metrics:{count:1},state:{},setup_data:{token:"private-token"}})', mixed);
assert.doesNotMatch(JSON.stringify(safeSummary), /private-token|setup_data/);
const arrival = load('mixed-activity', { seed: { users }, env: { WEBLENS_MIXED_ALLOW_MISSING_SCAN:'1', WEBLENS_MIXED_RATE:'300', WEBLENS_MIXED_THINK_SECONDS:'0' } });
assert.equal(vm.runInContext('options.scenarios.mixed_activity.executor', arrival), 'constant-arrival-rate');
assert.equal(vm.runInContext('options.scenarios.mixed_activity.maxVUs', arrival), 500);
const gates = JSON.parse(vm.runInContext('JSON.stringify(options.thresholds)', arrival));
assert.deepEqual(gates['http_req_failed{purpose:activity}'], ['rate<0.001']);
assert.deepEqual(gates['http_req_duration{name:scan_pages}'], ['p(95)<1000', 'p(99)<2000']);
for (const name of ['dashboard_summary', 'website_list', 'scan_list', 'scan_progress']) {
  assert.deepEqual(gates[`http_req_duration{name:${name}}`], ['p(95)<500', 'p(99)<1000']);
}
assert.deepEqual(gates.dropped_iterations, ['count==0']);
assert(vm.runInContext('options.summaryTrendStats.includes("p(99)")', arrival));
vm.runInContext('setup()', arrival);
const invalidPacing = load('mixed-activity', { seed: { users }, env: { WEBLENS_MIXED_RATE:'300' } });
assert.throws(() => vm.runInContext('setup()', invalidPacing), /zero think time/);
calls.length = 0;
for (let i = 0; i < 5; i++) { mixed.__ITER = i; vm.runInContext('scenario()', mixed); }
assert.equal(calls.length, 5);
assert(calls.every(({ url }) => !url.includes('/scans/null') && !url.includes('/scans/undefined')));
assert(calls.every(({ url }) => /dashboard\/summary|websites/.test(url)));
mixed.__VU = 3; mixed.__ITER = 3;
vm.runInContext('scenario()', mixed);
assert.match(calls.at(-1).url, /\/api\/v1\/scans\//);
mixed.__ENV.WEBLENS_MIXED_ALLOW_MISSING_SCAN = '0';
assert.throws(() => vm.runInContext('setup()', mixed), /Incomplete mixed-workload seed/);
mixed.__ENV.WEBLENS_MIXED_ALLOW_MISSING_SCAN = '1';
vm.runInContext('users[3].scanId = users[2].scanId;', mixed);
assert.throws(() => vm.runInContext('setup()', mixed), /duplicate verified scans/);
for (const count of [25, 50]) {
  const small = load('mixed-activity', { seed: { users: users.slice(0, count).map((u, i) => ({ ...u, scanId: `018f0f00-0000-7000-8000-${String(i).padStart(12, '0')}` })) }, env: { WEBLENS_MIXED_VUS: String(count) } });
  vm.runInContext('setup()', small);
  small.__ENV.WEBLENS_ACK_HIGH_LOAD = '0';
  assert.throws(() => vm.runInContext('setup()', small), /acknowledgement/);
}
console.log('PASS: timeout elapsed/errors/correlation, no admission replay, 25/50/500 API users, strict and duplicate refusal; no network.');

const activityTrace = load('mixed-activity', { seed: { users: users.slice(0, 25) },
  env: { WEBLENS_MIXED_VUS: '25', WEBLENS_TRACE_ERRORS: '1' } });
activityTrace.calls = calls;
const traceStart = logs.length;
vm.runInContext(`token = 'private-token';
  http.get = (url, options) => { calls.push({url, options}); return {status:503,
    timings:{duration:7}, json:()=> 'SCAN_REPORT_BUSY', error_code:0}; };
  scenario();`, activityTrace);
const errorTrace = JSON.parse(logs.at(-1));
assert.equal(errorTrace.status, 503);
assert.equal(errorTrace.code, 'SCAN_REPORT_BUSY');
assert.equal(errorTrace.correlationId, calls.at(-1).options.headers['X-Correlation-ID']);
assert.match(errorTrace.correlationId, /^[A-Za-z0-9._-]{1,64}$/);
assert.doesNotMatch(logs.slice(traceStart).join(''), /private-token|private-password|Authorization/);
vm.runInContext(`http.get = () => ({status:503, timings:{duration:7}, json:()=> 'secret body / url'}); scenario();`, activityTrace);
assert.equal(JSON.parse(logs.at(-1)).code, 'HTTP_503');
assert.doesNotMatch(logs.at(-1), /secret body/);
const beforeDisabled = logs.length;
activityTrace.__ENV.WEBLENS_TRACE_ERRORS = '0';
vm.runInContext('scenario()', activityTrace);
assert.equal(logs.length, beforeDisabled, 'Error trace must remain opt-in');
console.log('PASS: error traces preserve status/code/correlation without body, token, or high-cardinality metric tag.');

const balanced = load('mixed-activity', { seed: { users: users.slice(0, 25) },
  env: { WEBLENS_MIXED_VUS: '25', WEBLENS_MIXED_ROUTE_OFFSET: '1' } });
balanced.http.get = (url, options) => { calls.push({ url, options }); return { status: 200 }; };
vm.runInContext('token = "private-token";', balanced);
const balancedStart = calls.length;
for (let index = 0; index < 5; index++) { balanced.__VU = index + 1; balanced.__ITER = 0; vm.runInContext('scenario()', balanced); }
assert.equal(new Set(calls.slice(balancedStart).map(c => c.url)).size, 5, 'VU offsets spread initial route roles');
assert(calls.slice(balancedStart).some(c => c.url.endsWith('/pages?limit=20')));
const invalidOffset = load('mixed-activity', { seed: { users: [] }, env: { WEBLENS_MIXED_ROUTE_OFFSET: '2' } });
assert.throws(() => vm.runInContext('setup()', invalidOffset), /ROUTE_OFFSET/);

const readLogs = [];
const readCalls = [];
let readNow = 1000;
const apiSource = readFileSync(new URL('./k6/api-read.js', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '')
  .replace('export default function', 'function scenario')
  .replace(/export /g, '');
const apiRead = vm.createContext({
  __ENV: { WEBLENS_TRACE_READS: '1', WEBLENS_WEBSITE_ID: 'owned-site', WEBLENS_SCAN_ID: scanId },
  __VU: 1, __ITER: 0, Date: { now: () => readNow },
  console: { log: (line) => readLogs.push(line) }, check: () => {}, sleep: () => {},
  http: { get: (url, options) => {
    readCalls.push({ url, options });
    readNow += 5000;
    return { status: 0, error_code: 1050, timings: { duration: 5000, connecting: 0,
      tls_handshaking: 0, waiting: 5000, receiving: 0 } };
  } },
});
vm.runInContext(apiSource, apiRead);
vm.runInContext('scenario({ token: "private-token" })', apiRead);
assert.equal(readCalls.length, 5, 'Read diagnostic must not retry timed-out requests');
assert.equal(new Set(readCalls.map((call) => call.options.headers['X-Correlation-ID'])).size, 5);
const parsedReadLogs = readLogs.map((line) => JSON.parse(line));
assert.equal(parsedReadLogs.length, 5);
parsedReadLogs.forEach((entry, index) => {
  assert.match(entry.correlationId, /^[A-Za-z0-9._-]{1,64}$/);
  assert.equal(entry.correlationId, readCalls[index].options.headers['X-Correlation-ID']);
  assert.equal(entry.status, 0);
  assert.equal(entry.errorCode, 1050);
  assert.equal(entry.waitingMs, 5000);
  assert.equal(entry.elapsedMs, 5000);
  assert.equal(readCalls[index].options.timeout, '5s');
});
assert.doesNotMatch(readLogs.join(''), /private-token|Authorization|owned-site/);
apiRead.__ENV.WEBLENS_TRACE_READS = '0';
apiRead.__ITER = 1;
vm.runInContext('scenario({ token: "private-token" })', apiRead);
assert.equal(readCalls.length, 10);
assert.equal(readLogs.length, 5, 'Read tracing must remain opt-in');
assert.notEqual(readCalls[0].options.headers['X-Correlation-ID'], readCalls[5].options.headers['X-Correlation-ID']);
console.log('PASS: opt-in API metadata, bounded unique correlation, timeout retained, no retry/secret/metric-label; no network.');
