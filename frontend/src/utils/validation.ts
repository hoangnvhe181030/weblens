const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

export function validatePublicUrl(value: string): string | null {
  const candidate = value.trim()
  if (!candidate) return 'Hãy nhập địa chỉ website.'

  try {
    const url = new URL(candidate)
    if (!HTTP_PROTOCOLS.has(url.protocol)) return 'Chỉ chấp nhận địa chỉ HTTP hoặc HTTPS.'
    if (url.username || url.password) return 'Địa chỉ không được chứa thông tin đăng nhập.'
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return 'Tên miền chưa hợp lệ.'
    return null
  } catch {
    return 'Địa chỉ website chưa đúng định dạng, ví dụ https://example.com.'
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
