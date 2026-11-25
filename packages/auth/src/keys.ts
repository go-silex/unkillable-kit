/** Hash an API key for storage (never store plaintext). High-entropy only — not passwords. */
export async function hashApiKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Constant-time equality for equal-length hex digests (Workers-safe, no node:crypto). */
export async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length || a.length % 2 !== 0) return false
  const ba = hexToBytes(a)
  const bb = hexToBytes(b)
  if (ba.byteLength !== bb.byteLength) return false
  let diff = 0
  for (let i = 0; i < ba.byteLength; i++) diff |= ba[i]! ^ bb[i]!
  return diff === 0
}

/** Generate a demo sk_ key (plaintext shown once to client). */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const body = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sk_${body}`
}

export function hasApiKeyFormat(plaintext: string): boolean {
  return plaintext.startsWith('sk_') && plaintext.length >= 12
}

/** Stable prefix for DB index lookup (not secret enough alone — always pair with hash). */
export function apiKeyPrefix(plaintext: string): string {
  if (!hasApiKeyFormat(plaintext)) {
    throw new Error('invalid api key format for prefix')
  }
  return plaintext.slice(0, 12)
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m?.[1]?.trim() || null
}

/** A Bearer in the Kit's key namespace; any other Bearer token is not a Kit credential. */
export function hasKitKeyBearer(header: string | null | undefined): boolean {
  return parseBearer(header)?.startsWith('sk_') === true
}

/**
 * Verify a presented `sk_` against its stored hash.
 *
 * @capability auth-api-key-verify
 * @tag security
 * @invariant api-key-compare-is-constant-time: comparison goes through timingSafeEqualHex — never === on a digest — ADR-0002 D6 § Credential comparison
 */
export async function verifyApiKey(plaintext: string, expectedHash: string): Promise<boolean> {
  const h = await hashApiKey(plaintext)
  return timingSafeEqualHex(h, expectedHash)
}
