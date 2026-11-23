import { expect } from 'vitest'
import {
  type SessionRoundTripCeilings,
  sessionRoundTripTests,
} from '../../../packages/auth/src/test/session-round-trips'
import { DEMO_EMAIL, DEMO_PASSWORD } from './services/auth'
import { createApiTestContext, TEST_ORIGIN } from './test/api-fixture'
import { createRouteFixture } from './test/d1-route-fixture'

const ceilings: SessionRoundTripCeilings = {
  getSession: 8,
  getSessionRefresh: 9,
  listSessions: 16,
  listSessionsRefresh: 17,
  listAccounts: 16,
  updateUser: 16,
  changePassword: 17,
  changePasswordRevoke: 22,
  verifyPassword: 16,
  signOut: 13,
  revokeSession: 13,
  revokeSessions: 12,
  revokeOtherSessions: 13,
  unlinkAccount: 18,
  postGetSession: 14,
  updateSession: 15,
  changeEmail: 15,
  deleteUser: 15,
  deleteUserCallback: 14,
  linkSocial: 15,
  getAccessToken: 16,
  refreshToken: 16,
  accountInfo: 16,
}

sessionRoundTripTests({
  ceilings,
  organizationDenyCeiling: 5,
  magicLinks: true,
  async createFixture() {
    const { app, env, cookie, probe } = await createRouteFixture()
    return {
      db: env.DB,
      cookie,
      credentials: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      request: (path, init) => {
        const headers = new Headers(init?.headers)
        headers.set('origin', TEST_ORIGIN)
        return app.request(path, { ...init, headers }, env)
      },
      measure: probe,
    }
  },
  async readMountedApi() {
    const { app, env } = createApiTestContext()
    let api: object | undefined
    app.get('/_test/better-auth-api', (c) => {
      api = c.get('betterAuth')?.api
      return c.body(null, 204)
    })
    expect((await app.request('/_test/better-auth-api', undefined, env)).status).toBe(204)
    if (!api) throw new Error('Example middleware did not bind Better Auth')
    return api
  },
})
