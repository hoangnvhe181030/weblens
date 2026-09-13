import { isIP } from 'node:net'

const SENSITIVE_QUERY_KEY = /(authorization|cookie|credential|password|passwd|secret|session|token|api[-_]?key)/i

export function validatedHttpUrl(raw, label) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} phải là URL tuyệt đối hợp lệ.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} chỉ chấp nhận HTTP hoặc HTTPS.`)
  }
  if (url.username || url.password) throw new Error(`${label} không được chứa userinfo.`)
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new Error(`${label} không được truyền dữ liệu nhạy cảm trong query string.`)
    }
  }
  url.hash = ''
  return url
}

export function resolveSameOriginPath(baseUrl, rawPath, label) {
  if (!rawPath.startsWith('/')) throw new Error(`${label} phải bắt đầu bằng dấu /.`)
  const target = validatedHttpUrl(new URL(rawPath, baseUrl).toString(), label)
  if (target.origin !== baseUrl.origin) throw new Error(`${label} không được đổi origin.`)
  return target
}

export function enforceTargetScope(urls, { allowNonLoopback, confirmTargetOwnership }) {
  const nonLoopback = urls.filter((url) => !isLoopbackHostname(url.hostname))
  if (nonLoopback.length === 0) return
  if (!allowNonLoopback || !confirmTargetOwnership) {
    throw new Error(
      'Target không phải loopback. Chỉ tiếp tục với môi trường bạn sở hữu bằng cả '
      + '--allow-non-loopback và --confirm-target-ownership.',
    )
  }
}

export function enforceHighLoadAcknowledgement({
  concurrency = 0,
  operations = 0,
  durationMs = 0,
  pages = 0,
  fanout = 0,
  bodyBytes = 0,
}, acknowledged) {
  const highLoad = concurrency > 500
    || operations > 100_000
    || durationMs > 10 * 60_000
    || pages > 1_000
    || fanout > 1_000
    || bodyBytes > 1024 * 1024
  if (highLoad && !acknowledged) {
    throw new Error(
      'Cấu hình có thể làm cạn CPU, RAM, socket hoặc ổ đĩa. Thêm '
      + '--acknowledge-high-load để xác nhận rủi ro trên môi trường kiểm thử.',
    )
  }
}

export function sanitizedUrl(url) {
  const copy = new URL(url)
  copy.username = ''
  copy.password = ''
  for (const key of [...copy.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) copy.searchParams.set(key, '[REDACTED]')
  }
  return copy.toString()
}

export function isLoopbackHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  return false
}
