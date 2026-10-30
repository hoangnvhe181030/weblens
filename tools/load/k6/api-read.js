import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = (__ENV.WEBLENS_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const websiteId = __ENV.WEBLENS_WEBSITE_ID;
const scanId = __ENV.WEBLENS_SCAN_ID;
const vus = Number(__ENV.WEBLENS_VUS || 1);

export const options = {
  maxRedirects: 0,
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  scenarios: {
    api_read: {
      executor: 'constant-vus',
      vus,
      duration: __ENV.WEBLENS_DURATION || '30s',
    },
  },
  thresholds: {
    'http_req_failed{purpose:read}': ['rate<0.01'],
    'http_req_duration{purpose:read}': ['p(95)<1000', 'p(99)<1500'],
    'http_req_duration{name:dashboard_summary}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{name:website_list}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{name:scan_list}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{name:scan_progress}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{name:scan_pages}': ['p(95)<1000', 'p(99)<1500'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  if (!/^https?:\/\/[^/?#]+$/.test(baseUrl) || baseUrl.includes('@')) {
    throw new Error('WEBLENS_BASE_URL must be an origin without credentials, path, or query');
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)
      && (__ENV.WEBLENS_ALLOW_REMOTE !== '1'
        || __ENV.WEBLENS_CONFIRM_TARGET_HOST !== baseUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, ''))) {
    throw new Error('Remote targets require WEBLENS_ALLOW_REMOTE=1 and matching WEBLENS_CONFIRM_TARGET_HOST');
  }
  if (!Number.isInteger(vus) || vus < 1 || (vus > 20 && __ENV.WEBLENS_ACK_HIGH_LOAD !== '1')) {
    throw new Error('WEBLENS_VUS must be positive; above 20 requires WEBLENS_ACK_HIGH_LOAD=1');
  }
  if (!__ENV.WEBLENS_EMAIL || !__ENV.WEBLENS_PASSWORD || !websiteId) {
    throw new Error('WEBLENS_EMAIL, WEBLENS_PASSWORD, and WEBLENS_WEBSITE_ID are required');
  }

  const login = http.post(`${baseUrl}/api/v1/auth/sessions`, JSON.stringify({
    email: __ENV.WEBLENS_EMAIL,
    password: __ENV.WEBLENS_PASSWORD,
  }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
    tags: { name: 'auth_login', purpose: 'setup' },
  });
  if (login.status !== 200 || !login.json('accessToken')) {
    throw new Error(`Login preflight failed with HTTP ${login.status}`);
  }
  const token = login.json('accessToken');
  const ownedWebsite = http.get(`${baseUrl}/api/v1/websites/${websiteId}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: '5s',
    tags: { name: 'website_preflight', purpose: 'setup' },
  });
  if (ownedWebsite.status !== 200 || ownedWebsite.json('id') !== websiteId) {
    throw new Error(`Website preflight failed with HTTP ${ownedWebsite.status}`);
  }
  return { token };
}

export default function ({ token }) {
  const headers = { Authorization: `Bearer ${token}` };
  const read = (path, name) => {
    const started = Date.now();
    const correlationId = `read-${__VU}-${__ITER}-${name}-${started}`;
    const response = http.get(`${baseUrl}${path}`, {
      headers: { ...headers, 'X-Correlation-ID': correlationId },
      timeout: '5s',
      tags: { name, purpose: 'read' },
    });
    check(response, { 'API read returns 200': (result) => result.status === 200 });
    if (__ENV.WEBLENS_TRACE_READS === '1') {
      console.log(JSON.stringify({
        type: 'api_read_trace', name, correlationId, status: response.status,
        errorCode: response.error_code || 0, elapsedMs: Date.now() - started,
        durationMs: response.timings.duration,
        connectingMs: response.timings.connecting, tlsMs: response.timings.tls_handshaking,
        waitingMs: response.timings.waiting, receivingMs: response.timings.receiving,
      }));
    }
  };

  read('/api/v1/dashboard/summary', 'dashboard_summary');
  read('/api/v1/websites?page=0&size=20', 'website_list');
  read(`/api/v1/websites/${websiteId}/scans?page=0&size=20`, 'scan_list');
  if (scanId) {
    read(`/api/v1/scans/${scanId}`, 'scan_progress');
    read(`/api/v1/scans/${scanId}/pages?limit=20`, 'scan_pages');
  }
  sleep(1);
}
