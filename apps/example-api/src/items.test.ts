import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { DEMO_EMAIL, DEMO_EMAIL_B, DEMO_PASSWORD, DEMO_PASSWORD_B } from './seed/demo-data'
import { TENANCY_PASSWORD } from './seed/tenancy-data'
import { loginCookie, seedDemoEnv, sessionHeaders } from './test/api-fixture'
import { createMemoryEnv } from './test/memory-env'

const ORIGIN = 'http://localhost:5173'

async function mintOrgKey(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createMemoryEnv>,
  cookie: string,
  organizationId: string,
) {
  const mint = await app.request(
    '/api/keys',
    {
      method: 'POST',
      headers: sessionHeaders(cookie, undefined, ORIGIN),
      body: JSON.stringify({ organizationId, scopes: ['read', 'write', 'admin'] }),
    },
    env,
  )
  expect(mint.status).toBe(200)
  const body = (await mint.json()) as { key: string }
  expect(body.key.startsWith('sk_')).toBe(true)
  return body.key
}

async function loginAs(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createMemoryEnv>,
  email: string,
  password: string,
) {
  await seedDemoEnv(env, { notes: true, environment: 'test' })
  return loginCookie(app, env, email, password, ORIGIN)
}

describe('MasterData demo_items API', () => {
  it('requires auth', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const res = await app.request('/api/items', {}, env)
    expect(res.status).toBe(401)
  })

  it('CRUD + IDOR isolation + conflict on code', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await loginAs(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const cookieA = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const cookieB = await loginAs(app, env, DEMO_EMAIL_B, DEMO_PASSWORD_B)

    const create = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, 'org_acme', ORIGIN),
        body: JSON.stringify({
          code: 'sku-alpha',
          label: 'Alpha item',
          description: 'demo catalog',
        }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const created = (await create.json()) as { item: { id: string; code: string } }
    expect(created.item.code).toBe('sku-alpha')
    const id = created.item.id

    const dup = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, 'org_acme', ORIGIN),
        body: JSON.stringify({ code: 'sku-alpha', label: 'Dup' }),
      },
      env,
    )
    expect(dup.status).toBe(409)
    const dupBody = (await dup.json()) as { error: { code: string } }
    expect(dupBody.error.code).toBe('CONFLICT')

    const listA = await app.request('/api/items', { headers: { cookie: staffCookie } }, env)
    expect(listA.status).toBe(200)
    const listed = (await listA.json()) as { items: { id: string }[] }
    expect(listed.items.some((i) => i.id === id)).toBe(true)

    const idorGetA = await app.request(`/api/items/${id}`, { headers: { cookie: cookieA } }, env)
    expect(idorGetA.status).toBe(404)
    const idorGet = await app.request(`/api/items/${id}`, { headers: { cookie: cookieB } }, env)
    expect(idorGet.status).toBe(404)

    // Two write-capable members of org_acme: grant passes; subject WHERE must still 404.
    const ownerCookie = await loginAs(app, env, 'team-owner@kit.local', TENANCY_PASSWORD)
    const idorPatch = await app.request(
      `/api/items/${id}`,
      {
        method: 'PATCH',
        headers: sessionHeaders(ownerCookie, 'org_acme', ORIGIN),
        body: JSON.stringify({ label: 'Hacked' }),
      },
      env,
    )
    expect(idorPatch.status).toBe(404)

    const idorDel = await app.request(
      `/api/items/${id}`,
      { method: 'DELETE', headers: sessionHeaders(ownerCookie, 'org_acme', ORIGIN) },
      env,
    )
    expect(idorDel.status).toBe(404)

    const stillStaff = await app.request(
      `/api/items/${id}`,
      { headers: { cookie: staffCookie } },
      env,
    )
    expect(stillStaff.status).toBe(200)
    const kept = (await stillStaff.json()) as { item: { label: string } }
    expect(kept.item.label).toBe('Alpha item')

    const patch = await app.request(
      `/api/items/${id}`,
      {
        method: 'PATCH',
        headers: sessionHeaders(staffCookie, 'org_acme', ORIGIN),
        body: JSON.stringify({ label: 'Alpha v2', active: false }),
      },
      env,
    )
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as { item: { label: string; active: boolean } }
    expect(patched.item.label).toBe('Alpha v2')
    expect(patched.item.active).toBe(false)

    const filtered = await app.request(
      '/api/items?q=Alpha',
      { headers: { cookie: staffCookie } },
      env,
    )
    expect(filtered.status).toBe(200)
    const fbody = (await filtered.json()) as { items: { id: string }[] }
    expect(fbody.items.some((i) => i.id === id)).toBe(true)

    const del = await app.request(
      `/api/items/${id}`,
      { method: 'DELETE', headers: sessionHeaders(staffCookie, 'org_acme', ORIGIN) },
      env,
    )
    expect(del.status).toBe(200)
    const gone = await app.request(`/api/items/${id}`, { headers: { cookie: staffCookie } }, env)
    expect(gone.status).toBe(404)
  })
})

describe('demo_items personal kennel (M-10)', () => {
  it('allows team-reader to create their own kennel row without an org grant', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'team-reader@kit.local', TENANCY_PASSWORD)

    const create = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, 'org_team', ORIGIN),
        body: JSON.stringify({ code: 'LEAK', label: 'should fail' }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const body = (await create.json()) as { item: { code: string } }
    expect(body.item.code).toBe('LEAK')

    const list = await app.request('/api/items', { headers: { cookie } }, env)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { items: { code: string }[] }
    expect(listed.items.some((i) => i.code === 'LEAK')).toBe(true)
  })

  it('returns 404 when team-reader PATCH/DELETE a staff-created row (subject WHERE)', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await loginAs(app, env, 'staff@kit.local', TENANCY_PASSWORD)
    const created = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, 'org_acme', ORIGIN),
        body: JSON.stringify({ code: 'acme-pin', label: 'staff row' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const { item } = (await created.json()) as { item: { id: string; label: string } }

    const readerCookie = await loginAs(app, env, 'team-reader@kit.local', TENANCY_PASSWORD)
    const patch = await app.request(
      `/api/items/${item.id}`,
      {
        method: 'PATCH',
        headers: sessionHeaders(readerCookie, 'org_team', ORIGIN),
        body: JSON.stringify({ label: 'Hacked' }),
      },
      env,
    )
    expect(patch.status).toBe(404)
    const patchBody = (await patch.json()) as { error: { code: string } }
    expect(patchBody.error.code).toBe('NOT_FOUND')

    const del = await app.request(
      `/api/items/${item.id}`,
      { method: 'DELETE', headers: sessionHeaders(readerCookie, 'org_team', ORIGIN) },
      env,
    )
    expect(del.status).toBe(404)
    const delBody = (await del.json()) as { error: { code: string } }
    expect(delBody.error.code).toBe('NOT_FOUND')

    const still = await app.request(
      `/api/items/${item.id}`,
      { headers: { cookie: staffCookie } },
      env,
    )
    expect(still.status).toBe(200)
    const kept = (await still.json()) as { item: { label: string } }
    expect(kept.item.label).toBe('staff row')
  })

  it('returns 201 when team-reader POSTs without X-Org-Id', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'team-reader@kit.local', TENANCY_PASSWORD)

    const create = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, undefined, ORIGIN),
        body: JSON.stringify({ code: 'NOHDR', label: 'personal row' }),
      },
      env,
    )
    expect(create.status).toBe(201)

    const list = await app.request('/api/items', { headers: { cookie } }, env)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { items: { code: string }[] }
    expect(listed.items.some((i) => i.code === 'NOHDR')).toBe(true)
  })

  it('returns 201 when staff POSTs with X-Org-Id org_acme', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookie = await loginAs(app, env, 'staff@kit.local', TENANCY_PASSWORD)

    const create = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(cookie, 'org_acme', ORIGIN),
        body: JSON.stringify({ code: 'acme-write', label: 'staff write' }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const body = (await create.json()) as { item: { code: string } }
    expect(body.item.code).toBe('acme-write')
  })

  it('returns 404 on GET IDOR demo@ vs demo-b@ without org header', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const cookieA = await loginAs(app, env, DEMO_EMAIL, DEMO_PASSWORD)
    const cookieB = await loginAs(app, env, DEMO_EMAIL_B, DEMO_PASSWORD_B)

    const own = await app.request(
      '/api/items/item_seed_catalog_a',
      { headers: { cookie: cookieA } },
      env,
    )
    expect(own.status).toBe(200)

    const idorGet = await app.request(
      '/api/items/item_seed_catalog_a',
      { headers: { cookie: cookieB } },
      env,
    )
    expect(idorGet.status).toBe(404)
  })

  it('personal kennel: subject list ignores org; org-bound key still sees own rows', async () => {
    const app = createApp()
    const env = createMemoryEnv()
    const staffCookie = await loginAs(app, env, 'staff@kit.local', TENANCY_PASSWORD)

    const create = await app.request(
      '/api/items',
      {
        method: 'POST',
        headers: sessionHeaders(staffCookie, 'org_acme', ORIGIN),
        body: JSON.stringify({ code: 'kennel-acme', label: 'Personal row' }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const { item } = (await create.json()) as { item: { id: string } }

    const listNoOrg = await app.request('/api/items', { headers: { cookie: staffCookie } }, env)
    expect(listNoOrg.status).toBe(200)
    const listed = (await listNoOrg.json()) as { items: { id: string }[] }
    expect(listed.items.some((row) => row.id === item.id)).toBe(true)

    const key = await mintOrgKey(app, env, staffCookie, 'org_beta')
    const listKey = await app.request(
      '/api/items',
      { headers: { authorization: `Bearer ${key}` } },
      env,
    )
    expect(listKey.status).toBe(200)
    const keyed = (await listKey.json()) as { items: { id: string }[] }
    expect(keyed.items.some((row) => row.id === item.id)).toBe(true)
  })
})
