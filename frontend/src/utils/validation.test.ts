import { describe, expect, it } from 'vitest'
import { formatBytes, validatePublicUrl } from './validation'

describe('validatePublicUrl', () => {
  it('accepts public HTTP and HTTPS syntax', () => {
    expect(validatePublicUrl('https://example.com/path')).toBeNull()
    expect(validatePublicUrl('http://example.com')).toBeNull()
  })

  it('rejects non-http protocols and credentials', () => {
    expect(validatePublicUrl('file:///etc/passwd')).toMatch(/HTTP/)
    expect(validatePublicUrl('https://user:secret@example.com')).toMatch(/đăng nhập/)
  })

  it('returns a useful error for malformed values', () => {
    expect(validatePublicUrl('example')).toMatch(/định dạng|Tên miền/)
    expect(validatePublicUrl('')).toMatch(/nhập/)
  })
})

describe('formatBytes', () => {
  it('formats bounded resource sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})
