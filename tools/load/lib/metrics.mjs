export class Metrics {
  constructor(maxLatencyMs) {
    this.latencies = new Uint32Array(maxLatencyMs + 2)
    this.statuses = new Map()
    this.errors = new Map()
    this.started = 0
    this.completed = 0
    this.succeeded = 0
    this.failed = 0
    this.timedOut = 0
    this.inFlight = 0
    this.maxInFlight = 0
    this.bytesReceived = 0
    this.latencyCount = 0
    this.latencySumMs = 0
    this.minLatencyMs = Number.POSITIVE_INFINITY
    this.maxLatencyMs = 0
  }

  start() {
    this.started += 1
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
  }

  finish({ status, error, latencyMs, bytes = 0 }) {
    this.completed += 1
    this.inFlight -= 1
    this.bytesReceived += bytes
    this.recordLatency(latencyMs)

    if (status !== undefined) {
      increment(this.statuses, String(status))
      if (status >= 200 && status < 400) this.succeeded += 1
      else this.failed += 1
      return
    }

    this.failed += 1
    increment(this.errors, error ?? 'UNKNOWN_ERROR')
    if (error === 'TIMEOUT') this.timedOut += 1
  }

  snapshot(elapsedMs) {
    return {
      started: this.started,
      completed: this.completed,
      succeeded: this.succeeded,
      failed: this.failed,
      timedOut: this.timedOut,
      inFlight: this.inFlight,
      maxInFlight: this.maxInFlight,
      bytesReceived: this.bytesReceived,
      throughputRps: round(elapsedMs > 0 ? this.completed * 1000 / elapsedMs : 0),
      latencyMs: {
        min: this.latencyCount === 0 ? null : this.minLatencyMs,
        mean: this.latencyCount === 0 ? null : round(this.latencySumMs / this.latencyCount),
        p50: this.percentile(0.50),
        p95: this.percentile(0.95),
        p99: this.percentile(0.99),
        max: this.latencyCount === 0 ? null : this.maxLatencyMs,
      },
      statusHistogram: sortedObject(this.statuses),
      errorHistogram: sortedObject(this.errors),
    }
  }

  recordLatency(rawLatencyMs) {
    const latencyMs = Math.max(0, Math.ceil(rawLatencyMs))
    const bucket = Math.min(latencyMs, this.latencies.length - 1)
    this.latencies[bucket] += 1
    this.latencyCount += 1
    this.latencySumMs += latencyMs
    this.minLatencyMs = Math.min(this.minLatencyMs, latencyMs)
    this.maxLatencyMs = Math.max(this.maxLatencyMs, latencyMs)
  }

  percentile(fraction) {
    if (this.latencyCount === 0) return null
    const rank = Math.max(1, Math.ceil(this.latencyCount * fraction))
    let cumulative = 0
    for (let index = 0; index < this.latencies.length; index += 1) {
      cumulative += this.latencies[index]
      if (cumulative >= rank) return index
    }
    return this.latencies.length - 1
  }
}

export function classifyRequestError(error) {
  if (typeof error?.category === 'string') return error.category
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'TIMEOUT'
  const code = error?.cause?.code ?? error?.code
  const known = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ])
  return known.has(code) ? code : 'NETWORK_ERROR'
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function round(value) {
  return Math.round(value * 100) / 100
}
