import { createKitRequireAuth } from '@kit/auth/hono'
import type { Context, MiddlewareHandler } from 'hono'
import { sessionCookieNameFromEnv } from '../lib/session-env'
import type { AppEnv } from '../types'

const authenticate: MiddlewareHandler<AppEnv> = createKitRequireAuth<Context<AppEnv>>((c) =>
  sessionCookieNameFromEnv(c.env),
) as MiddlewareHandler<AppEnv>

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('impersonationRow')) {
    await next()
    return
  }
  await authenticate(c, next)
}
