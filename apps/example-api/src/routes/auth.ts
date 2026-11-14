import { OpenAPIHono } from '@hono/zod-openapi'
import { createBetterAuthHandler } from '@kit/auth/hono'
import type { AppEnv } from '../types'

export const authRoutes = new OpenAPIHono<AppEnv>()

authRoutes.all('/api/auth/*', createBetterAuthHandler())
