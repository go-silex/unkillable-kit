export type SessionCookieInput = { header: string | null; name: string; secret: string }

/** Verify Better Auth's MAC for exactly the cookie name emitted by the composing App. */
export async function verifySessionCookie({
  header,
  name,
  secret,
}: SessionCookieInput): Promise<string | null> {
  if (!header) return null
  let encoded: string | undefined
  for (const pair of header.split(';')) {
    const equals = pair.indexOf('=')
    if (equals < 0 || pair.slice(0, equals).trim() !== name) continue
    encoded = pair.slice(equals + 1).trim()
    if (encoded.startsWith('"')) encoded = encoded.slice(1, -1)
    break // Better Auth reads the first occurrence, including when it is invalid.
  }
  if (!encoded) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  const dot = decoded.lastIndexOf('.')
  if (dot < 1) return null
  const signature = decoded.slice(dot + 1)
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return null
  const token = decoded.slice(0, dot)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return (await crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(atob(signature), (value) => value.charCodeAt(0)),
    encoder.encode(token),
  ))
    ? token
    : null
}
