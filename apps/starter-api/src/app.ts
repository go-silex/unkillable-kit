import { corsAllowlist } from '@kit/auth'
import { createBetterAuthHandler, originGuard, securityHeaders } from '@kit/auth/hono'
import { AppError, newRequestId, toApiErrorBody } from '@kit/core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { members } from './modules/members/routes'
import { bindPlatform } from './platform/auth'
import { me } from './platform/me'
import type { AppEnv } from './platform/types'

export function createApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    const id = newRequestId()
    c.set('requestId', id)
    c.header('x-request-id', id)
    await next()
  })
  app.use('*', securityHeaders)
  app.use('*', async (c, next) =>
    cors({
      origin: (origin) => (corsAllowlist(c.env).includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    })(c, next),
  )
  app.use('*', originGuard)
  app.use('*', bindPlatform)
  app.onError((err, c) => {
    const { body, status } = toApiErrorBody(err, c.get('requestId'))
    return c.json(body, status as ContentfulStatusCode)
  })
  app.notFound((c) => {
    const { body, status } = toApiErrorBody(AppError.notFound(), c.get('requestId'))
    return c.json(body, status as ContentfulStatusCode)
  })
  app.get('/health', (c) => c.json({ ok: true }))
  app.all('/api/auth/*', createBetterAuthHandler())
  app.route('/', me)
  app.route('/', members)
  return app
}
