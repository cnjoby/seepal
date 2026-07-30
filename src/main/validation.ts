import { isAbsolute } from 'node:path'

export function requireString(
  value: unknown,
  field: string,
  maximumLength = 512,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new TypeError(`${field} is invalid`)
  }
  return value
}

export function requireAbsolutePath(value: unknown): string {
  const path = requireString(value, 'path', 4096)
  if (!isAbsolute(path)) throw new TypeError('path must be absolute')
  return path
}

export function requireRecord(
  value: unknown,
  field = 'input',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is invalid`)
  }
  return value as Record<string, unknown>
}

export function isTrustedRendererUrl(
  senderUrl: string,
  allowedRendererUrl: string,
): boolean {
  try {
    const sender = new URL(senderUrl)
    const allowed = new URL(allowedRendererUrl)
    if (allowed.protocol === 'file:') {
      return sender.protocol === 'file:' && sender.pathname === allowed.pathname
    }
    return sender.origin === allowed.origin
  } catch {
    return false
  }
}
