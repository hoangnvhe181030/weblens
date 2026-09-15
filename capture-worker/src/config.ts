export interface Config {
  port: number
  serviceToken: string
  databaseUrl: string
  clickhouseUrl: string
  clickhouseDatabase: string
  clickhouseUsername: string
  clickhousePassword: string
  s3Endpoint: string
  s3Region: string
  s3AccessKey: string
  s3SecretKey: string
  s3Bucket: string
  controlEventUrl: string
  concurrency: number
  workerPollMillis: number
  analyticsPollMillis: number
  eventPollMillis: number
  reconstructionGcPollMillis: number
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function loadConfig(): Config {
  const serviceToken = required('WEBLENS_SERVICE_TOKEN')
  if (serviceToken.length < 32 || serviceToken.length > 512) {
    throw new Error('WEBLENS_SERVICE_TOKEN must contain 32 to 512 characters')
  }
  return {
    port: integer('CAPTURE_PORT', 8082, 1, 65535),
    serviceToken,
    databaseUrl: required('CAPTURE_DATABASE_URL'),
    clickhouseUrl: required('CLICKHOUSE_URL'),
    clickhouseDatabase: process.env.CLICKHOUSE_CAPTURE_DATABASE?.trim() || 'weblens_capture_analytics',
    clickhouseUsername: required('CLICKHOUSE_USERNAME'),
    clickhousePassword: required('CLICKHOUSE_PASSWORD'),
    s3Endpoint: required('S3_ENDPOINT'),
    s3Region: process.env.S3_REGION?.trim() || 'us-east-1',
    s3AccessKey: required('S3_ACCESS_KEY'),
    s3SecretKey: required('S3_SECRET_KEY'),
    s3Bucket: process.env.S3_CAPTURE_BUCKET?.trim() || 'weblens-captures',
    controlEventUrl: required('WEBLENS_CONTROL_CAPTURE_EVENT_URL'),
    concurrency: integer('CAPTURE_CONCURRENCY', 2, 1, 10),
    workerPollMillis: integer('CAPTURE_WORKER_POLL_MS', 500, 100, 60_000),
    analyticsPollMillis: integer('CAPTURE_ANALYTICS_POLL_MS', 500, 100, 60_000),
    eventPollMillis: integer('CAPTURE_EVENT_POLL_MS', 500, 100, 60_000),
    reconstructionGcPollMillis: integer('CAPTURE_RECONSTRUCTION_GC_POLL_MS', 30_000, 1_000, 300_000),
  }
}
