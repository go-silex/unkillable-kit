import * as orgRoles from '@kit/auth/repos/org-roles'
import { upsertOrgModule, upsertPlatformModule } from '@kit/auth/repos/platform-modules'
import { kitNotifications } from '@kit/notifications/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotificationFixture, type NotificationFixture } from './fixture'

type Page = { items: Array<{ content: { title: string; body: string; href: string } }> }
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

beforeEach(async () => {
  f = await createNotificationFixture()
})
afterEach(() => {
  f.env.close()
})

describe('notification inbox HTTP rendering', () => {
  it('renders exact supported locales with private cache headers and trusted links', async () => {
    await insert('localized')
    for (const [language, locale, title] of [
      ['en', 'en', 'Task assigned'],
      ['fr', 'fr', 'Tâche assignée'],
      ['en-US', 'fr', 'Tâche assignée'],
      ['en,fr;q=0.8', 'fr', 'Tâche assignée'],
      ['', 'fr', 'Tâche assignée'],
    ]) {
      const headers: Record<string, string> = {
        Origin: 'https://attacker.invalid',
        Host: 'attacker.invalid',
      }
      if (language) headers['Accept-Language'] = language
      const response = await request(base, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-language')).toBe(locale)
      expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-language')
      expect(response.headers.get('cache-control')?.replaceAll(' ', '')).toBe('private,no-store')
      const body = (await response.json()) as Page
      expect(body.items[0]?.content).toEqual({ title, body: 'Café 東京', href: '/app/tasks' })
    }
  })

  it('renders an approval tuple as a trusted web run link', async () => {
    await upsertPlatformModule(f.db, {
      moduleId: 'flows',
      available: true,
      configJson: null,
      updatedAt: Date.now(),
    })
    await upsertOrgModule(f.db, {
      organizationId: 'org_acme',
      moduleId: 'flows',
      enabled: true,
      updatedAt: Date.now(),
    })
    const admin = await orgRoles.findRoleByKey(f.db, 'org_acme', 'admin')
    expect(admin).toBeTruthy()
    await orgRoles.upsertGrant(f.db, {
      organizationId: 'org_acme',
      roleId: admin!.id,
      moduleId: 'flows',
      access: 'read',
    })
    await insert('approval', {
      typeKey: 'flows.approval_requested',
      moduleId: 'flows',
      sourceKind: 'flow_approval',
      sourceId: JSON.stringify(['run_123', 'task_123']),
      paramsJson: '{}',
    })
    const response = await request(base, {
      headers: { 'Accept-Language': 'en', Host: 'attacker.invalid' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Page
    expect(body.items[0]?.content).toEqual({
      title: 'Approval requested',
      body: 'A flow needs approval.',
      href: '/app/flows/runs/run_123',
    })
  })

  it('fails closed without exposing corrupt parameters or unknown types', async () => {
    for (const [id, fields] of [
      ['bad_shape', { paramsJson: '{"taskTitle":123,"private":"private-secret"}' }],
      ['bad_type', { typeKey: 'private-secret.unknown' }],
    ] as const) {
      await insert(id, fields)
      const response = await request(base)
      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain('private-secret')
      await f.db.delete(kitNotifications).where(eq(kitNotifications.id, id))
    }
  })
})
