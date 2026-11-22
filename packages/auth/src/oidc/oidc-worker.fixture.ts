import type { KitD1Database } from '@kit/db'
import { createBetterAuth } from '../better-auth-factory'
import { createOidcProvider, endOidcUserSessions, registerOidcClient } from './oidc-provider'

const ORIGIN = 'https://auth.example.test'

// This entry point is bundled only by the workerd integration test.
export default {
  async fetch(
    request: Request,
    env: { DB: KitD1Database; DB_SECONDARY: KitD1Database; OIDC_ENABLED: boolean },
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const pending: Promise<unknown>[] = []
    const auth = createBetterAuth({
      database: request.headers.get('x-test-database') === 'secondary' ? env.DB_SECONDARY : env.DB,
      secret: 'test-better-auth-secret-xxxxxxxx32c!!',
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      allowPublicSignup: true,
      oidcProvider: env.OIDC_ENABLED
        ? createOidcProvider({
            loginPage: '/login',
            waitUntil: (promise) => {
              pending.push(promise)
              ctx.waitUntil(promise)
            },
          })
        : undefined,
    })
    const path = new URL(request.url).pathname
    if (path === '/__test/register') {
      const client = await registerOidcClient(auth, {
        headers: request.headers,
        redirectUris: ['https://client.example.test/callback'],
        backchannelLogoutUri: 'https://client.example.test/backchannel-logout',
        firstParty: true,
      })
      return Response.json(client)
    }
    if (path === '/__test/logout') {
      const { userId } = (await request.json()) as { userId: string }
      const result = await endOidcUserSessions(auth, userId)
      ctx.waitUntil(
        Promise.allSettled(pending).then(() =>
          fetch('https://client.example.test/__test/background-complete', { method: 'POST' }),
        ),
      )
      return Response.json({ ...result, backgroundTasks: pending.length })
    }
    return auth.handler(request)
  },
}
