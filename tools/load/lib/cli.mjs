const BOOLEAN_OPTIONS = new Set([
  'acknowledge-high-load',
  'allow-non-loopback',
  'confirm-target-ownership',
  'help',
  'plan-only',
  'cancel-on-timeout',
  'no-cancel-on-timeout',
])

export function parseCommandLine(argv) {
  const [command, ...tokens] = argv
  const options = new Map()

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '-h') {
      put(options, 'help', true)
      continue
    }
    if (!token.startsWith('--')) {
      throw new Error(`Đối số không hợp lệ: ${token}`)
    }

    const separator = token.indexOf('=')
    const name = token.slice(2, separator === -1 ? undefined : separator)
    if (!name) throw new Error('Tên tùy chọn không được để trống.')

    if (separator !== -1) {
      if (BOOLEAN_OPTIONS.has(name)) {
        throw new Error(`--${name} là cờ boolean và không nhận giá trị.`)
      }
      put(options, name, token.slice(separator + 1))
      continue
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      put(options, name, true)
      continue
    }

    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} cần một giá trị.`)
    }
    put(options, name, value)
    index += 1
  }

  return { command, options }
}

export function assertKnownOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Tùy chọn không được hỗ trợ: --${name}`)
  }
}

export function stringOption(options, name, fallback) {
  const value = options.get(name)
  if (value === undefined) return fallback
  if (value === true || value.length === 0) throw new Error(`--${name} cần một giá trị không rỗng.`)
  return value
}

export function integerOption(options, name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = stringOption(options, name, fallback === undefined ? undefined : String(fallback))
  if (raw === undefined) return undefined
  if (!/^-?\d+$/.test(raw)) throw new Error(`--${name} phải là số nguyên.`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} phải nằm trong khoảng ${minimum}..${maximum}.`)
  }
  return value
}

export function durationOption(options, name, fallback, bounds = {}) {
  const raw = stringOption(options, name, fallback)
  if (raw === undefined) return undefined
  const value = parseDuration(raw, name)
  const minimum = bounds.minimum ?? 1
  const maximum = bounds.maximum ?? 24 * 60 * 60 * 1000
  if (value < minimum || value > maximum) {
    throw new Error(`--${name} phải nằm trong khoảng ${formatDuration(minimum)}..${formatDuration(maximum)}.`)
  }
  return value
}

export function flag(options, name) {
  return options.get(name) === true
}

export function requireExactlyOneLimit(operationLimit, durationMs) {
  if (operationLimit === undefined && durationMs === undefined) {
    throw new Error('Phải đặt giới hạn hữu hạn bằng --operations hoặc --duration.')
  }
}

function parseDuration(raw, name) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw)
  if (!match) throw new Error(`--${name} phải có đơn vị ms, s, m hoặc h (ví dụ 30s).`)
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const value = Number(match[1]) * factors[match[2]]
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.ceil(value))) {
    throw new Error(`--${name} không hợp lệ.`)
  }
  return Math.ceil(value)
}

function formatDuration(milliseconds) {
  return milliseconds >= 1000 ? `${milliseconds / 1000}s` : `${milliseconds}ms`
}

function put(options, name, value) {
  if (options.has(name)) throw new Error(`Không được lặp lại --${name}.`)
  options.set(name, value)
}
