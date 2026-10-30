import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const baseUrl = (__ENV.WEBLENS_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const scanCount = Number(__ENV.WEBLENS_SCAN_COUNT || 1);
const staggerMillis = Number(__ENV.WEBLENS_ADMISSION_STAGGER_MS || 0);
const warmConnection = __ENV.WEBLENS_ADMISSION_WARM_CONNECTION === '1';
const seed = JSON.parse(open(__ENV.WEBLENS_PHASE5_SEED_FILE));
const admissionFailed = new Rate('scan_admission_failed');
const admissionDuration = new Trend('scan_admission_duration', true);
const admissionElapsed = new Trend('scan_admission_elapsed', true);

export const options = {
  setupTimeout: `${Math.ceil(scanCount * 1.1) + 120}s`,
  maxRedirects: 0,
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  scenarios: {
    submit_scans: {
      executor: 'per-vu-iterations',
      vus: scanCount,
      iterations: 1,
      maxDuration: `${Math.ceil(scanCount * staggerMillis / 1000) + 30}s`,
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    scan_admission_failed: ['rate<0.01'],
    scan_admission_duration: ['p(95)<1000', 'p(99)<2000'],
    scan_admission_elapsed: ['p(95)<1000', 'p(99)<2000'],
    'http_req_failed{purpose:admission}': ['rate<0.01'],
  },
};

export function setup() {
  if (!Number.isInteger(staggerMillis) || staggerMillis < 0 || staggerMillis > 1000
      || !['0', '1'].includes(__ENV.WEBLENS_ADMISSION_WARM_CONNECTION || '0')) {
    throw new Error('Admission probe requires stagger 0..1000ms and warm connection 0 or 1');
  }
  if (!/^https?:\/\/[^/?#]+$/.test(baseUrl) || baseUrl.includes('@')) {
    throw new Error('WEBLENS_BASE_URL must be an origin without credentials, path, or query');
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)
      && (__ENV.WEBLENS_ALLOW_REMOTE !== '1'
        || __ENV.WEBLENS_CONFIRM_TARGET_HOST !== baseUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, ''))) {
    throw new Error('Remote targets require WEBLENS_ALLOW_REMOTE=1 and matching WEBLENS_CONFIRM_TARGET_HOST');
  }
  if (!Number.isInteger(scanCount) || scanCount < 1 || (scanCount > 150 && scanCount !== 500)
      || (scanCount > 10 && __ENV.WEBLENS_ACK_HIGH_LOAD !== '1')) {
    throw new Error('WEBLENS_SCAN_COUNT must be 1..150 or 500; above 10 requires WEBLENS_ACK_HIGH_LOAD=1');
  }
  if (!__ENV.WEBLENS_PHASE5_PASSWORD || !__ENV.WEBLENS_PHASE5_LEVEL_ID
      || !Array.isArray(seed.entries) || seed.entries.length < scanCount) {
    throw new Error('Phase 5 seed, password, and level ID are required');
  }
  for (const entry of seed.entries.slice(0, scanCount)) {
    const correlationId = entry.correlationId || `${__ENV.WEBLENS_PHASE5_LEVEL_ID}-admission-${entry.index}`;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(correlationId)) throw new Error('Invalid admission correlation ID');
  }
  if (scanCount === 500) {
    const entries = seed.entries.slice(0, scanCount);
    for (const field of ['index', 'accountIndex', 'email', 'websiteId']) {
      if (entries.some((entry) => entry[field] === undefined || entry[field] === null || entry[field] === '')
          || new Set(entries.map((entry) => entry[field])).size !== scanCount) {
        throw new Error(`500-user workload requires distinct ${field}`);
      }
    }
    if (entries.some((entry, index) => entry.index !== index)) throw new Error('Admission seed index order mismatch');
  }

  const tokens = {};
  for (const entry of seed.entries.slice(0, scanCount)) {
    if (tokens[entry.accountIndex]) continue;
    // One generator IP stays below 60 logins/minute; admission itself remains a simultaneous burst.
    sleep(1.1);
    const response = http.post(`${baseUrl}/api/v1/auth/sessions`, JSON.stringify({
      email: entry.email,
      password: __ENV.WEBLENS_PHASE5_PASSWORD,
    }), {
      headers: { 'Content-Type': 'application/json' },
      timeout: '5s',
      tags: { name: 'auth_login', purpose: 'setup' },
    });
    if (response.status !== 200 || !response.json('accessToken')) {
      throw new Error(`Login preflight failed for account ${entry.accountIndex}: HTTP ${response.status}`);
    }
    tokens[entry.accountIndex] = response.json('accessToken');
  }
  return { tokens };
}

export default function ({ tokens }) {
  const index = __VU - 1;
  const entry = seed.entries[index];
  const correlationId = entry.correlationId || `${__ENV.WEBLENS_PHASE5_LEVEL_ID}-admission-${index}`;
  if (staggerMillis) sleep(index * staggerMillis / 1000);
  if (warmConnection) {
    const warm = http.get(`${baseUrl}/actuator/health`, {
      timeout: '5s', tags: { name: 'admission_connection_probe', purpose: 'probe' },
    });
    console.log(`ADMISSION_PROBE|${index}|warm|${warm.status}`);
  }
  const startedAt = Date.now();
  const response = http.post(
    `${baseUrl}/api/v1/websites/${entry.websiteId}/scans`,
    null,
    {
      headers: {
        Authorization: `Bearer ${tokens[entry.accountIndex]}`,
        'Idempotency-Key': `${__ENV.WEBLENS_PHASE5_LEVEL_ID}-${index}`,
        'X-Correlation-ID': correlationId,
      },
      timeout: '5s',
      tags: { name: 'create_scan', purpose: 'admission' },
    },
  );
  const elapsedMs = Date.now() - startedAt;
  admissionElapsed.add(elapsedMs);
  // status 0 can report HTTP duration 0 while connection setup used the whole timeout.
  if (response.status > 0) admissionDuration.add(response.timings.duration);
  let scanId = null;
  try { scanId = response.json('id'); } catch (_) { /* response check below */ }
  const accepted = response.status === 202 && typeof scanId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId);
  admissionFailed.add(!accepted);
  check(response, { 'scan accepted once': () => accepted });
  console.log(`PHASE5_SCAN|${index}|${entry.accountIndex}|${accepted ? scanId : ''}|${response.status}|${response.timings.duration}|${elapsedMs}|${response.error_code || 0}|${response.timings.blocked}|${response.timings.connecting}|${response.timings.tls_handshaking}|${response.timings.sending}|${response.timings.waiting}|${response.timings.receiving}|${correlationId}`);
}

// k6's default summary export includes setup tokens. This opt-in file is metrics-only.
export function handleSummary(data) {
  const safe = JSON.stringify({ metrics: data.metrics, state: data.state }, null, 2);
  return __ENV.WEBLENS_SAFE_SUMMARY_FILE ? { [__ENV.WEBLENS_SAFE_SUMMARY_FILE]: safe } : { stdout: safe };
}
