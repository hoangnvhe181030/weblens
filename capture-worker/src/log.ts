type Level = 'info' | 'warn' | 'error'

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !/(token|password|secret|body|html)/i.test(key)),
  )
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...safeFields })}\n`)
}
