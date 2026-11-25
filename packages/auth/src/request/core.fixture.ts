import { AppError } from '@kit/core'
import { Hono } from 'hono'
import { vi } from 'vitest'
import type { BetterAuthLike } from '../better-auth-port'
import { apiKeyPrefix, hashApiKey } from '../keys'
import { DELEGATION_ROWS, fixture } from '../snapshot/load.fixture'
import { recordSessionCookie } from './effective-session-cookie'
import {
  createRequestAuthorization,
  type RequestAuthorizationOptions,
} from './request-authorization'

export type TestEnv = {
  Variables: { subject?: string; authMethod?: string; orgId?: string; platformRole?: string }
}
export const KEY = 'sk_fixture_sensitive_key_material'

export function setup(options: Omit<RequestAuthorizationOptions<TestEnv>, 'auth' | 'db'> = {}) {
  const seeded = fixture()
  const auth: BetterAuthLike = {
    api: {
      getSession: vi.fn(() => {
        throw new Error('Use the read-only issuer cookie path')
      }),
    },
  }
  recordSessionCookie(auth, seeded.cookie.name, seeded.cookie.secret)
  const authorization = createRequestAuthorization<TestEnv>({
    db: () => seeded.db,
    auth: () => auth,
    ...options,
  })
  const app = new Hono<TestEnv>()
  const onError = vi.fn((error: unknown, _view: unknown, _subject: unknown) => {
    if (error instanceof AppError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      )
    throw error
  })
  app.onError((error, c) => onError(error, authorization.view(c), c.get('subject')))
  const browser = { cookie: seeded.cookie.header }
  return {
    ...seeded,
    app,
    authorization,
    auth,
    onError,
    browser,
    async apiKey() {
      const hash = await hashApiKey(KEY)
      seeded.sqlite
        .prepare('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)')
        .run('key-id', apiKeyPrefix(KEY), hash, 'actor', 'chosen', 'read')
      return { hash, headers: { Authorization: `Bearer ${KEY}` } }
    },
    attachDelegation() {
      seeded.sqlite.exec(DELEGATION_ROWS)
    },
  }
}
