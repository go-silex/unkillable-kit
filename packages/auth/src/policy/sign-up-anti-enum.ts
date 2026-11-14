/**
 * Wire-level anti-enumeration for public email sign-up.
 *
 * Better Auth returns distinct 4xx codes (EMAIL_PASSWORD_SIGN_UP_DISABLED vs
 * USER_ALREADY_EXISTS vs PASSWORD_TOO_SHORT). Normalize failed
 * POST /api/auth/sign-up/email so Network-tab observers cannot distinguish
 * existence from validation. Disabled is a distinct 403 (flag off).
 *
 * - 2xx success: pass through (cookies intact)
 * - 429: pass through
 * - 5xx: pass through (route scrubber keeps status, kit envelope)
 * - disabled (BA 400 EMAIL_PASSWORD_SIGN_UP_DISABLED): 403 FORBIDDEN kit
 * - other 4xx: 400 VALIDATION_ERROR kit (no Set-Cookie)
 */

const SIGN_UP_EMAIL = /\/api\/auth\/sign-up\/email\/?$/i

export function isEmailSignUpPath(pathname: string): boolean {
  return SIGN_UP_EMAIL.test(pathname)
}

function kitJson(status: number, code: string, message: string, requestId: string): Response {
  const headers = new Headers()
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('x-request-id', requestId)
  return new Response(JSON.stringify({ error: { code, message }, requestId }), { status, headers })
}

export async function normalizeEmailSignUpResponse(
  req: Request,
  res: Response,
  requestId: string,
): Promise<Response> {
  if (req.method !== 'POST') return res
  let pathname: string
  try {
    pathname = new URL(req.url).pathname
  } catch {
    return res
  }
  if (!isEmailSignUpPath(pathname)) return res
  if (res.status < 400 || res.status >= 500 || res.status === 429) return res

  let disabled = false
  try {
    const body = (await res.clone().json()) as { code?: unknown }
    disabled = body.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED'
  } catch {
    disabled = false
  }

  if (disabled) {
    return kitJson(403, 'FORBIDDEN', 'Public sign-up is disabled', requestId)
  }
  return kitJson(400, 'VALIDATION_ERROR', 'Could not create the account', requestId)
}
