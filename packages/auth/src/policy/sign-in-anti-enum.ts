/**
 * Wire-level anti-enumeration for password sign-in.
 *
 * Better Auth may return different status codes / body shapes for unknown email
 * vs wrong password. Normalize failed POST /api/auth/sign-in/email to a single
 * kit envelope so Network-tab observers cannot distinguish.
 *
 * - 2xx success: pass through (cookies intact)
 * - 429: pass through (rate limit is intentional signal)
 * - 5xx: pass through (route scrubber keeps status, kit envelope)
 * - other 4xx: force 401 + UNAUTHORIZED kit body (no Set-Cookie)
 */

const SIGN_IN_EMAIL = /\/api\/auth\/sign-in\/email\/?$/i

export function isPasswordSignInPath(pathname: string): boolean {
  return SIGN_IN_EMAIL.test(pathname)
}

export function normalizePasswordSignInResponse(
  req: Request,
  res: Response,
  requestId: string,
): Response {
  if (req.method !== 'POST') return res
  let pathname: string
  try {
    pathname = new URL(req.url).pathname
  } catch {
    return res
  }
  if (!isPasswordSignInPath(pathname)) return res
  if (res.status < 400 || res.status >= 500 || res.status === 429) return res

  const headers = new Headers()
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('x-request-id', requestId)
  // Do not copy Set-Cookie / WWW-Authenticate — fail closed as unauthenticated.
  return new Response(
    JSON.stringify({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
      },
      requestId,
    }),
    { status: 401, headers },
  )
}
