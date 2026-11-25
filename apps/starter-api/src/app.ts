import { createBetterAuthHandler } from '@kit/auth/hono'
import { AppError, toApiErrorBody } from '@kit/core'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { members } from './modules/members/routes'
import { authorization, betterAuthMount, platformMiddleware } from './platform/auth'
import { me } from './platform/me'
import type { AppEnv } from './platform/types'

export function createApp() {
  const app = new Hono<AppEnv>()
  authorization.middleware(app, () => app.use('*', ...platformMiddleware))
  app.onError((err, c) => {
    const { body, status } = toApiErrorBody(err, c.get('requestId'))
    return c.json(body, status as ContentfulStatusCode)
  })
  app.notFound((c) => {
    const { body, status } = toApiErrorBody(AppError.notFound(), c.get('requestId'))
    return c.json(body, status as ContentfulStatusCode)
  })
  app.get('/health', (c) => c.json({ ok: true }))
  app.all('/api/auth/*', betterAuthMount, createBetterAuthHandler())
  app.route('/', me)
  app.route('/', members)
  return app
}
