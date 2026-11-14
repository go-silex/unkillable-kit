import * as orgRoles from '@kit/auth/repos/org-roles'
import { upsertOrgModule } from '@kit/auth/repos/platform-modules'
import { baMember } from '@kit/auth/schema'
import { kitNotifications } from '@kit/notifications/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotificationFixture, type NotificationFixture } from './fixture'

type InboxItem = {
  id: string
  type: string
  source: { kind: string; id: string }
  content: { title: string; body: string; href: string }
  readAt: number | null
  resolvedAt: number | null
}
type Page = { items: InboxItem[]; nextCursor: string | null; requestId: string }

const base = '/api/orgs/org_acme/notifications'
let f: NotificationFixture

async function insert(id: string, overrides: Partial<typeof kitNotifications.$inferInsert> = {}) {
  await f.db.insert(kitNotifications).values({
    id,
    orgId: 'org_acme',
    userId: 'user_staff',
    typeKey: 'tasks.assigned',
    sourceKind: 'task',
    sourceId: id,
    paramsJson: JSON.stringify({ taskTitle: 'Café 東京' }),
    moduleId: 'tasks',
    createdAt: 100,
    ...overrides,
  })
}

async function request(path: string, init: RequestInit = {}) {
  return f.app.request(
    path,
    { ...init, headers: { ...(await f.headersFor('user_staff', 'org_acme')), ...init.headers } },
    f.env,
  )
}
async function page(path = base): Promise<Page> {
  const response = await request(path)
  expect(response.status).toBe(200)
  return response.json() as Promise<Page>
}
async function count() {
  const response = await request(`${base}/unread-count`)
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ unreadCount: expect.any(Number) })
  if (
    !body ||
    typeof body !== 'object' ||
    !('unreadCount' in body) ||
    typeof body.unreadCount !== 'number'
  )
    throw new Error('Invalid unread count')
  return body.unreadCount
}
async function read(path: string, body = '{}') {
  return request(path, { method: 'POST', body })
}

beforeEach(async () => {
  f = await createNotificationFixture()
})
afterEach(() => {
  f.env.close()
})

describe('notification inbox HTTP behavior', () => {
  it('includes retained resolved rows in all but not unread, and paginates deterministically', async () => {
    await insert('id_a', { createdAt: Number.MAX_SAFE_INTEGER })
    await insert('id_b', { createdAt: Number.MAX_SAFE_INTEGER })
    await insert('id_c', { createdAt: 99, resolvedAt: 100 })
    await insert('id_d', { createdAt: 98, readAt: 101 })
    const first = await page(`${base}?limit=1`)
    expect(first.items.map((x) => x.id)).toEqual(['id_b'])
    expect(first.nextCursor).toBeTruthy()
    const second = await page(`${base}?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.items.map((x) => x.id)).toEqual(['id_a'])
    expect(second.nextCursor).toBeTruthy()
    const third = await page(`${base}?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`)
    expect(third.items.map((x) => x.id)).toEqual(['id_c', 'id_d'])
    expect(third.nextCursor).toBeNull()
    expect((await page(`${base}?filter=unread`)).items.map((x) => x.id)).toEqual(['id_b', 'id_a'])
    expect(await count()).toBe(2)
  })

  it('applies live module visibility to pages, count, single read and read-all', async () => {
    await insert('visible')
    await insert('other_user', { userId: 'user_team_owner' })
    expect(await count()).toBe(1)
    await upsertOrgModule(f.db, {
      organizationId: 'org_acme',
      moduleId: 'tasks',
      enabled: false,
      updatedAt: Date.now(),
    })
    expect((await page()).items).toEqual([])
    expect(await count()).toBe(0)
    expect((await read(`${base}/visible/read`)).status).toBe(404)
    const hiddenReadAll = await read(`${base}/read-all`)
    expect(hiddenReadAll.status).toBe(200)
    expect((await hiddenReadAll.json()) as object).toMatchObject({ ok: true, updated: 0 })
    await upsertOrgModule(f.db, {
      organizationId: 'org_acme',
      moduleId: 'tasks',
      enabled: true,
      updatedAt: Date.now(),
    })
    expect((await page()).items.map((item) => item.id)).toEqual(['visible'])
    expect(await count()).toBe(1)
    const all = await read(`${base}/read-all`)
    expect(all.status).toBe(200)
    expect((await all.json()) as object).toMatchObject({ ok: true, updated: 1 })
    expect(await count()).toBe(0)
    expect(
      (await f.db.select().from(kitNotifications).where(eq(kitNotifications.id, 'other_user')))[0]!
        .readAt,
    ).toBeNull()
  })

  it('returns field errors for an out-of-range limit without exposing private input', async () => {
    const privateCursor = 'private-secret'
    const response = await request(`${base}?limit=101&cursor=${privateCursor}`)
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain(privateCursor)
    const body = JSON.parse(text) as {
      error: { code: string; details: { fieldErrors: { limit: string[] } } }
      requestId: string
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.fieldErrors.limit).toEqual(
      expect.arrayContaining([expect.any(String)]),
    )
    expect(body.requestId).toEqual(expect.any(String))
    expect(body.requestId.length).toBeGreaterThan(0)
  })

  it('rejects malformed, unknown and repeated query parameters and strict mutation bodies', async () => {
    for (const query of [
      'q=x',
      'filter=all&filter=unread',
      'limit=1&limit=2',
      'limit=0',
      'limit=101',
      'filter=other',
      'cursor=!',
      'cursor=eyJjcmVhdGVkQXQiOjEsImlkIjoieCIsImV4dHJhIjoxfQ',
      `cursor=${'a'.repeat(513)}`,
    ]) {
      expect((await request(`${base}?${query}`)).status, query).toBe(400)
    }
    for (const suffix of ['/unread-count?limit=1', '/unread-count?x=1', '/unread-count?x=1&x=2'])
      expect((await request(`${base}${suffix}`)).status).toBe(400)
    for (const suffix of ['/read-all', '/missing/read']) {
      for (const body of ['{"extra":true}', '{"__proto__":{"admin":true}}', '[]'])
        expect((await read(`${base}${suffix}`, body)).status, `${suffix} ${body}`).toBe(400)
      expect((await read(`${base}${suffix}?x=1`)).status).toBe(400)
      expect((await read(`${base}${suffix}?x=1&x=2`)).status).toBe(400)
    }
  })

  it('uses live custom-role grants before list, count, and read mutations', async () => {
    await insert('custom', { userId: 'user_team_owner' })
    const created = await request('/api/orgs/org_acme/roles', {
      method: 'POST',
      body: JSON.stringify({
        key: 'inbox_viewer',
        name: 'Inbox viewer',
        grants: [{ moduleId: 'tasks', access: 'read' }],
      }),
    })
    expect(created.status).toBe(201)
    const role = await orgRoles.findRoleByKey(f.db, 'org_acme', 'inbox_viewer')
    expect(role).toBeTruthy()
    await f.db
      .update(baMember)
      .set({ role: 'inbox_viewer' })
      .where(eq(baMember.id, 'mem_org_acme_user_team_owner'))
    const headers = await f.headersFor('user_team_owner', 'org_acme')
    const call = (path: string, init: RequestInit = {}) =>
      f.app.request(path, { ...init, headers }, f.env)
    const visible = await call(base)
    expect(visible.status).toBe(200)
    const visiblePage = (await visible.json()) as Page
    expect(visiblePage.items.map((item) => item.id)).toEqual(['custom'])
    await orgRoles.deleteGrant(f.db, 'org_acme', role!.id, 'tasks')
    const hidden = await call(base)
    const hiddenPage = (await hidden.json()) as Page
    expect(hidden.status).toBe(200)
    expect(hiddenPage.items).toEqual([])
    const hiddenCount = await call(`${base}/unread-count`)
    expect(await hiddenCount.json()).toMatchObject({ unreadCount: 0 })
    expect((await call(`${base}/custom/read`, { method: 'POST', body: '{}' })).status).toBe(404)
    const all = await call(`${base}/read-all`, { method: 'POST', body: '{}' })
    expect(await all.json()).toMatchObject({ updated: 0 })
    await orgRoles.upsertGrant(f.db, {
      organizationId: 'org_acme',
      roleId: role!.id,
      moduleId: 'tasks',
      access: 'read',
    })
    const restored = await call(`${base}/unread-count`)
    expect(await restored.json()).toMatchObject({ unreadCount: 1 })
    expect((await call(`${base}/custom/read`, { method: 'POST', body: '{}' })).status).toBe(200)
  })

  it('round-trips a cursor at the maximum row-id and epoch bounds', async () => {
    const longId = `z${'x'.repeat(255)}`
    await insert(longId, { createdAt: Number.MAX_SAFE_INTEGER })
    await insert('a', { createdAt: Number.MAX_SAFE_INTEGER })
    const first = await page(`${base}?limit=1`)
    expect(first.items.map((item) => item.id)).toEqual([longId])
    expect(first.nextCursor).toBeTruthy()
    const next = await page(`${base}?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(next.items.map((item) => item.id)).toEqual(['a'])
    expect(next.nextCursor).toBeNull()
  })
})
