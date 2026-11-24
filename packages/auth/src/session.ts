/** Cookie names and parsing for Kit SPA sessions (ADR-0002). */
export const SESSION_COOKIE = 'kit_session'

const SECURE_PREFIX = '__Secure-'

export function parseCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=') || null
  }
  return null
}

/**
 * BA on-wire names: logical `name` (dev/test) or `__Secure-${name}` (staging/prod).
 * originGuard must use this — `sessionCookieNameFromEnv` is the logical name only.
 */
export function parseSessionCookie(header: string | null | undefined, name: string): string | null {
  return parseCookie(header, name) ?? parseCookie(header, `${SECURE_PREFIX}${name}`)
}
