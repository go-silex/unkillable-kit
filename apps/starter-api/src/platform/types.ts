import type { PlatformRole } from '@kit/auth'
import type { KitBetterAuth } from '@kit/auth/factory'
import { kitAuthSchema } from '@kit/auth/schema'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

export const schema = kitAuthSchema
export type Db = DrizzleD1Database<typeof schema>
export type Env = {
  DB: D1Database
  ENVIRONMENT?: string
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  SESSION_COOKIE_NAME?: string
  CORS_ORIGINS?: string
  ALLOW_PUBLIC_SIGNUP?: string
}
export type AppEnv = {
  Bindings: Env
  Variables: {
    db?: Db
    betterAuth?: KitBetterAuth
    requestId: string
    subject?: string
    authMethod?: 'session' | 'api_key'
    sessionId?: string
    keyOrganizationId?: string
    orgId?: string
    orgRole?: string
    orgBypass?: boolean
    platformRole?: PlatformRole | null
  }
}
