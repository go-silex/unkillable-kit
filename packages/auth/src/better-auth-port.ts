import type { SessionPayload } from './session'
import { clearSessionCookieHeader, SESSION_COOKIE } from './session'
import type { ResolveSessionInput, SessionPort } from './session-port'

/**
 * Minimal Better Auth surface used by the kit SessionPort adapter.
 * Apps pass a per-request `auth` instance (CF bindings pattern).
 */
export type BetterAuthLike = {
  api: {
    /** Bypass cookie cache and avoid refreshing expiry while resolving identity. */
    getSession: (opts: {
      headers: Headers
      query?: { disableRefresh?: boolean; disableCookieCache?: boolean }
    }) => Promise<{
      user: { id: string; email?: string | null }
      session: { id: string; expiresAt?: Date | string | null }
    } | null>
  }
}

export type CreateBetterAuthSessionPortOpts = {
  getAuth: () => BetterAuthLike | Promise<BetterAuthLike>
  isAccountActive: (subject: string) => Promise<boolean>
  cookieName?: string
}

function headersFromInput(input: ResolveSessionInput): Headers {
  if (input.headers) return input.headers
  const h = new Headers()
  if (input.cookieHeader) h.set('cookie', input.cookieHeader)
  return h
}

/** Parse BA expiresAt; return null if missing/unparseable (fail closed). */
function expFromSession(expiresAt: Date | string | null | undefined): number | null {
  if (expiresAt instanceof Date) {
    const n = Math.floor(expiresAt.getTime() / 1000)
    return Number.isFinite(n) ? n : null
  }
  if (typeof expiresAt === 'string') {
    const t = Date.parse(expiresAt)
    if (!Number.isNaN(t)) return Math.floor(t / 1000)
  }
  return null
}

/**
 * SessionPort adapter for Better Auth.
 * - `resolveSession` → `auth.api.getSession({ headers })`
 * - missing/unparseable expiresAt → null (fail closed)
 * - no sign/verify — session issuance owned by BA HTTP handler
 */
export function createBetterAuthSessionPort(opts: CreateBetterAuthSessionPortOpts): SessionPort {
  const cookieName = opts.cookieName ?? SESSION_COOKIE

  return {
    async resolveSession(input) {
      try {
        const auth = await opts.getAuth()
        const session = await auth.api.getSession({
          headers: headersFromInput(input),
          query: { disableRefresh: true, disableCookieCache: true },
        })
        if (
          !session?.user?.id ||
          typeof session.session?.id !== 'string' ||
          !session.session.id.trim()
        ) {
          return null
        }
        const exp = expFromSession(session.session?.expiresAt)
        if (exp == null) return null
        if (exp < Math.floor(Date.now() / 1000)) return null
        if ((await opts.isAccountActive(session.user.id)) !== true) return null
        return {
          sub: session.user.id,
          sessionId: session.session.id,
          email: session.user.email ?? '',
          exp,
        } satisfies SessionPayload
      } catch {
        // Treat auth-layer failures as no session (401). Infra misconfig surfaces earlier at factory.
        return null
      }
    },
    clearCookieHeader(headerOpts) {
      return clearSessionCookieHeader({ ...headerOpts, name: cookieName })
    },
  }
}
