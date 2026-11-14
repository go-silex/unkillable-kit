import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../../db/schema'
import { seedTenancyDemo } from '../../seed/seed-tenancy'
import { TENANCY_PERSONAS } from '../../seed/tenancy-data'
import {
  type ApiApp,
  type ApiEnv,
  bearerHeaders,
  createApiTestContext,
  loginCookie,
  sessionHeaders,
} from '../api-fixture'
import { hashFixtureCredential } from '../fixture-credential'

export type NotificationFixture = {
  app: ApiApp
  env: ApiEnv
  db: DrizzleD1Database<typeof schema>
  headersFor(userId: string, orgId?: string): Promise<Record<string, string>>
  bearerFor(userId: string, orgId: string): Promise<Record<string, string>>
}

/** Real migrations, seeded tenancy and lazily authenticated HTTP credentials. */
export async function createNotificationFixture(): Promise<NotificationFixture> {
  const { app, env, db } = createApiTestContext()
  await seedTenancyDemo(db, { environment: 'test', force: true }, hashFixtureCredential)
  const cookies = new Map<string, Promise<string>>()

  async function headersFor(userId: string, orgId?: string): Promise<Record<string, string>> {
    const persona = TENANCY_PERSONAS.find((entry) => entry.id === userId)
    if (!persona) throw new Error(`Unknown tenancy persona: ${userId}`)
    let cookie = cookies.get(userId)
    if (!cookie) {
      cookie = loginCookie(app, env, persona.email, persona.password)
      cookies.set(userId, cookie)
    }
    return sessionHeaders(await cookie, orgId)
  }

  async function bearerFor(userId: string, orgId: string): Promise<Record<string, string>> {
    const response = await app.request(
      '/api/keys',
      {
        method: 'POST',
        headers: await headersFor(userId, orgId),
        body: JSON.stringify({ organizationId: orgId, scopes: ['read', 'write', 'admin'] }),
      },
      env,
    )
    if (response.status !== 200) throw new Error(`API key mint failed: ${response.status}`)
    const { key } = (await response.json()) as { key: string }
    return bearerHeaders(key, orgId)
  }

  return { app, env, db, headersFor, bearerFor }
}
