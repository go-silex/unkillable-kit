import { expect } from 'vitest'
import {
  type SessionRoundTripCeilings,
  sessionRoundTripTests,
} from '../../../packages/auth/src/test/session-round-trips'
import { createApp } from './app'
import {
  createRouteFixture,
  createStarterHttpFixture,
  routeFixtureCredentials,
  starterTestOrigin,
} from './test/d1-route-fixture'

const ceilings: SessionRoundTripCeilings = {
  getSession: 3,
  getSessionRefresh: 4,
  listSessions: 11,
  listSessionsRefresh: 12,
  listAccounts: 11,
  updateUser: 11,
  changePassword: 12,
  changePasswordRevoke: 17,
  verifyPassword: 11,
  signOut: 8,
  revokeSession: 8,
  revokeSessions: 7,
  revokeOtherSessions: 8,
  unlinkAccount: 13,
  postGetSession: 9,
  updateSession: 10,
  changeEmail: 10,
  deleteUser: 10,
  deleteUserCallback: 9,
  linkSocial: 10,
  getAccessToken: 11,
  refreshToken: 11,
  accountInfo: 11,
}

sessionRoundTripTests({
  ceilings,
  organizationDenyCeiling: 0,
  magicLinks: false,
  async createFixture() {
    const { env, cookie, request, measure } = await createRouteFixture()
    return { db: env.DB, cookie, request, measure, credentials: routeFixtureCredentials }
  },
  async readMountedApi() {
    const { env } = createStarterHttpFixture()
    const app = createApp()
    let api: object | undefined
    app.get('/_test/better-auth-api', (c) => {
      api = c.get('betterAuth')?.api
      return c.body(null, 204)
    })
    const response = await app.request(`${starterTestOrigin}/_test/better-auth-api`, undefined, env)
    expect(response.status).toBe(204)
    if (!api) throw new Error('Starter middleware did not bind Better Auth')
    return api
  },
})
