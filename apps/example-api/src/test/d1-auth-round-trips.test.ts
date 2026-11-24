import { expect } from 'vitest'
import {
  type SessionRoundTripCeilings,
  sessionRoundTripTests,
} from '../../../../packages/auth/src/test/session-round-trips'
import { DEMO_EMAIL, DEMO_PASSWORD } from '../services/auth'
import { createApiTestContext, TEST_ORIGIN } from './api-fixture'
import { createRouteFixture } from './d1-route-fixture'

const ceilings: SessionRoundTripCeilings = {
  getSession: 4,
  getSessionRefresh: 5,
  listSessions: 12,
  listSessionsRefresh: 13,
  listAccounts: 12,
  updateUser: 12,
  changePassword: 13,
  changePasswordRevoke: 18,
  verifyPassword: 12,
  signOut: 9,
  revokeSession: 9,
  revokeSessions: 8,
  revokeOtherSessions: 9,
  unlinkAccount: 14,
  postGetSession: 10,
  updateSession: 11,
  changeEmail: 11,
  deleteUser: 11,
  deleteUserCallback: 10,
  linkSocial: 11,
  getAccessToken: 12,
  refreshToken: 12,
  accountInfo: 12,
}

sessionRoundTripTests({
  ceilings,
  organizationDenyCeiling: 1,
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
