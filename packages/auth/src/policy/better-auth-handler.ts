import { AppError } from '@kit/core'
import type { Handler } from 'hono'
import type { BetterAuthLike } from '../better-auth-port'
import { isBaOrganizationRoute } from '../org-route-deny'
import { throttleBetterAuthRequest } from '../repos/ba-throttle'
import type { KitRepoDb } from '../repos/db-type'
import { clientIp } from '../repos/rate-limit'
import { scrubBetterAuthServerError } from './ba-server-error'
import { normalizePasswordSignInResponse } from './sign-in-anti-enum'
import { normalizeEmailSignUpResponse } from './sign-up-anti-enum'

export type BetterAuthHandlerEnv = {
  Variables: {
    db?: KitRepoDb
    betterAuth?: BetterAuthLike & { handler(request: Request): Response | Promise<Response> }
    requestId?: string
  }
}

/** Mount on /api/auth/* after binding the request-scoped database and Better Auth instance. */
export function createBetterAuthHandler(): Handler<BetterAuthHandlerEnv> {
  return async (c) => {
    const auth = c.get('betterAuth')
    if (!auth) throw AppError.internal('Better Auth not initialized')
    if (isBaOrganizationRoute(new URL(c.req.raw.url).pathname)) {
      throw AppError.notFound(
        'Better Auth organization routes are off; use the kit organization APIs',
      )
    }
    const db = c.get('db')
    if (!db) throw AppError.internal('db not bound — withDb middleware required')
    await throttleBetterAuthRequest(db, {
      request: c.req.raw,
      ip: clientIp(c.req),
      sessionId: async () => {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
          query: { disableRefresh: true },
        })
        return session?.session.id ?? null
      },
    })
    const raw = await auth.handler(c.req.raw)
    const requestId = c.get('requestId') || 'req_unknown'
    const res = scrubBetterAuthServerError(raw, requestId)
    const signIn = normalizePasswordSignInResponse(c.req.raw, res, requestId)
    return normalizeEmailSignUpResponse(c.req.raw, signIn, requestId)
  }
}
