import { apiKeys, baUser } from '@kit/auth/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { mintApiKey } from './services/auth'
import { bearerHeaders, createApiTestContext, seedDemoEnv } from './test/api-fixture'

describe('API key scopes and account state', () => {
  it('requires an active owner even for scoped keys, and restores access after re-enabling', async () => {
    const { app, env, db } = createApiTestContext()
    await seedDemoEnv(env, { notes: false, environment: 'test' })

    const read = await mintApiKey(db, 'user_staff', {
      organizationId: 'org_acme',
      scopes: ['read'],
    })
    const write = await mintApiKey(db, 'user_staff', {
      organizationId: 'org_acme',
      scopes: ['write'],
    })
    const all = await mintApiKey(db, 'user_staff', {
      organizationId: 'org_acme',
      scopes: ['read', 'write', 'admin'],
    })
    const me = (key: string) => app.request('/api/me', { headers: bearerHeaders(key) }, env)

    const active = await me(read.key)
    expect(active.status).toBe(200)
    expect(await active.json()).toMatchObject({ subject: 'user_staff', authMethod: 'api_key' })
    expect((await me(write.key)).status).toBe(403)
    expect((await me(all.key)).status).toBe(200)

    await db.update(baUser).set({ disabled: true }).where(eq(baUser.id, 'user_staff'))
    for (const key of [read.key, write.key, all.key]) {
      expect((await me(key)).status).toBe(401)
    }

    await db.update(baUser).set({ disabled: false }).where(eq(baUser.id, 'user_staff'))
    expect((await me(read.key)).status).toBe(200)
    expect((await me(write.key)).status).toBe(403)
    expect((await me(all.key)).status).toBe(200)

    // Legacy or corrupt stored grants must not inherit authority from a valid key.
    for (const scopes of ['', 'read,unknown', 'read, write']) {
      await db.update(apiKeys).set({ scopes }).where(eq(apiKeys.id, read.id))
      expect((await me(read.key)).status).toBe(403)
    }
  })
})
