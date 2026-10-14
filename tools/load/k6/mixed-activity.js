import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { check, sleep } from 'k6';

const baseUrl = (__ENV.WEBLENS_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const users = JSON.parse(open(__ENV.WEBLENS_MIXED_SEED_FILE)).users;
const vus = Number(__ENV.WEBLENS_MIXED_VUS || users.length);
const authMode = __ENV.WEBLENS_MIXED_AUTH_MODE || 'paced';
const thinkSeconds = Number(__ENV.WEBLENS_MIXED_THINK_SECONDS ?? 3);
const rate = Number(__ENV.WEBLENS_MIXED_RATE || 0);
const routeOffset = __ENV.WEBLENS_MIXED_ROUTE_OFFSET || '0';
let token;
const apiErrors = new Counter('weblens_api_errors');
const ownerActivity = new Counter('weblens_owner_activity');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  setupTimeout: `${Math.ceil(vus * 1.1) + 120}s`,
  maxRedirects: 0,
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  scenarios: {
    mixed_activity: {
      ...(rate ? { executor: 'constant-arrival-rate', rate, timeUnit: '1s', preAllocatedVUs: vus, maxVUs: vus }
        : { executor: 'constant-vus', vus }),
      duration: __ENV.WEBLENS_MIXED_DURATION || '10m',
    },
  },
  thresholds: {
    'http_req_failed{purpose:activity}': ['rate<0.001'],
    'http_req_duration{purpose:activity}': ['p(95)<1000', 'p(99)<2000'],
    'http_req_duration{name:dashboard_summary}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:website_list}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:scan_list}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:scan_progress}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:scan_pages}': ['p(95)<1000', 'p(99)<2000'],
    ...(rate ? { dropped_iterations: ['count==0'] } : {}),
    checks: ['rate>0.999'],
    ...Object.fromEntries(['dashboard_summary', 'website_list', 'scan_list', 'scan_progress', 'scan_pages']
      .map(name => [`http_reqs{name:${name}}`, ['count>0']])),
  },
};

function login(user) {
  const response = http.post(`${baseUrl}/api/v1/auth/sessions`, JSON.stringify({
    email: user.email,
    password: __ENV.WEBLENS_MIXED_PASSWORD,
  }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
    tags: { name: 'auth_login', purpose: 'auth' },
  });
  check(response, { 'login succeeds': (result) => result.status === 200 });
  token = response.status === 200 ? response.json('accessToken') : null;
}

export default function (data) {
  const index = __VU - 1;
  const user = users[index];
  if (!user) throw new Error(`Missing benchmark user for VU ${__VU}`);
  if (__ITER === 0) {
    token = data?.tokens?.[index] || token;
    if (authMode === 'burst') sleep((index % 30) / 2);
  }
  if (!token) login(user);
  if (!token) { sleep(3); return; }

  const paths = [
    ['/api/v1/dashboard/summary', 'dashboard_summary'],
    ['/api/v1/websites?page=0&size=20', 'website_list'],
    [`/api/v1/websites/${user.websiteId}/scans?page=0&size=20`, 'scan_list'],
    ...(user.scanId ? [
      [`/api/v1/scans/${user.scanId}`, 'scan_progress'],
      [`/api/v1/scans/${user.scanId}/pages?limit=20`, 'scan_pages'],
    ] : []),
  ];
  const [path, name] = paths[(__ITER + (routeOffset === '1' ? index : 0)) % paths.length];
  const correlationId = `mixed-${__VU}-${__ITER}-${Date.now()}`;
  ownerActivity.add(1, { owner_index: String(index) });
  const request = () => http.get(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Correlation-ID': correlationId },
    timeout: '10s',
    tags: { name, purpose: 'activity' },
  });
  let response = request();
  if (response.status === 401) {
    login(user);
    if (token) response = request();
  }
  if (response.status !== 200) {
    let code = `HTTP_${response.status}`;
    try {
      const bodyCode = response.json('code');
      if (typeof bodyCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(bodyCode)) code = bodyCode;
    } catch {}
    apiErrors.add(1, { name, error_code: code });
    if (__ENV.WEBLENS_TRACE_ERRORS === '1') console.log(JSON.stringify({ type: 'activity_error', name,
      correlationId, status: response.status, code, networkErrorCode: response.error_code || 0,
      elapsedHttpMs: response.timings.duration }));
  }
  check(response, { 'activity returns 200': (result) => result.status === 200 });
  sleep(thinkSeconds);
}

export function setup() {
  if (!['0', '1'].includes(routeOffset)) throw new Error('WEBLENS_MIXED_ROUTE_OFFSET must be 0 or 1');
  if (!Number.isFinite(thinkSeconds) || thinkSeconds < 0 || thinkSeconds > 60
      || !Number.isInteger(rate) || rate < 0 || rate > 1000 || (rate && thinkSeconds !== 0)) {
    throw new Error('Invalid think time or arrival rate; rate mode requires zero think time');
  }
  if (!['paced', 'burst'].includes(authMode)) throw new Error('WEBLENS_MIXED_AUTH_MODE must be paced or burst');
  if (!/^https?:\/\/[^/?#]+$/.test(baseUrl) || baseUrl.includes('@')) {
    throw new Error('WEBLENS_BASE_URL must be an origin without credentials, path, or query');
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)
      && (__ENV.WEBLENS_ALLOW_REMOTE !== '1'
        || __ENV.WEBLENS_CONFIRM_TARGET_HOST !== baseUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, ''))) {
    throw new Error('Remote targets require WEBLENS_ALLOW_REMOTE=1 and matching WEBLENS_CONFIRM_TARGET_HOST');
  }
  if (!Number.isInteger(vus) || ![25, 50, 150, 500].includes(vus) || users.length !== vus
      || __ENV.WEBLENS_ACK_HIGH_LOAD !== '1' || !__ENV.WEBLENS_MIXED_PASSWORD) {
    throw new Error('Mixed workload requires 25, 50, 150 or 500 distinct users and explicit high-load acknowledgement');
  }
  for (const user of users) {
    if (!user.email || !user.websiteId || (!user.scanId && __ENV.WEBLENS_MIXED_ALLOW_MISSING_SCAN !== '1')) {
      throw new Error('Incomplete mixed-workload seed');
    }
    if (user.scanId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.scanId)) {
      throw new Error('Invalid mixed-workload scan identity');
    }
  }
  for (const field of ['email', 'websiteId']) {
    if (new Set(users.map((user) => user[field])).size !== vus) throw new Error(`Duplicate mixed-workload ${field}`);
  }
  const scanIds = users.map((user) => user.scanId).filter(Boolean);
  if (!scanIds.length || new Set(scanIds).size !== scanIds.length) throw new Error('Missing or duplicate verified scans');
  const tokens = {};
  if (authMode === 'paced') {
    for (let index = 0; index < users.length; index++) {
      sleep(1.1);
      login(users[index]);
      if (!token) throw new Error(`Mixed login setup failed for user ${index}`);
      tokens[index] = token;
    }
  }
  console.log(`MIXED_AUTH_MODE|${authMode}|${vus}`);
  console.log(`MIXED_ROUTE_OFFSET|${routeOffset}`);
  return { tokens };
}

// Default summary export contains setup_data tokens; explicitly emit metrics only.
export function handleSummary(data) {
  const safe = JSON.stringify({ metrics: data.metrics, state: data.state }, null, 2);
  return __ENV.WEBLENS_SAFE_SUMMARY_FILE ? { [__ENV.WEBLENS_SAFE_SUMMARY_FILE]: safe }
    : { stdout: safe };
}
