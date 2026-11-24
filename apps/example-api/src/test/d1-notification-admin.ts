import { finishDelivery, listDeliveryMetadata } from '@kit/notifications/repos'
import { expect } from 'vitest'
import type { KitDb } from '../lib/db-type'
import { TENANCY_PASSWORD } from '../seed/tenancy-data'
import { type ApiApp, type ApiEnv, loginCookie, sessionHeaders } from './api-fixture'
import { createRouteFixture, type Probe } from './d1-route-fixture'

const orgId = 'org_acme'
const memberId = 'user_team_owner'
const orgPath = `/api/orgs/${orgId}`
const inbox = `${orgPath}/notifications`
const notificationType = 'tasks.assigned'

async function notificationRuleId(response: Response) {
  const { rule } = (await response.json()) as { rule: { id: string } }
  return rule.id
}

async function expectRow(response: Response, row: Record<string, unknown>) {
  expect(await response.json()).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining(row)]),
  })
}

async function seedInbox(app: ApiApp, env: ApiEnv, db: KitDb, staffHeaders: HeadersInit) {
  for (const title of ['First inbox task', 'Second inbox task']) {
    const created = await app.request(
      '/api/tasks',
      {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({
          title,
          boardKey: 'main',
          visibility: 'shared',
          assigneeIds: [memberId],
        }),
      },
      env,
    )
    expect(created.status).toBe(201)
  }

  // The memory Workflow binding admits deliveries without executing them.
  const { items: pending } = await listDeliveryMetadata(
    db,
    { orgId },
    { targetKind: 'user', channel: 'email', type: notificationType, status: 'pending' },
  )
  const [delivery] = pending
  if (!delivery) throw new Error('Task assignment did not create a pending email delivery')
  expect(
    await finishDelivery(
      db,
      { orgId, kind: 'user', id: delivery.id },
      { status: 'failed' },
      Date.now(),
    ),
  ).toBe(true)
  return delivery.id
}

async function measureInbox(probe: Probe, headers: HeadersInit) {
  const count = await probe('GET /api/orgs/:orgId/notifications/unread-count', 7, {
    path: `${inbox}/unread-count`,
    headers,
  })
  expect(await count.json()).toMatchObject({ unreadCount: 2 })
  const page = await probe('GET /api/orgs/:orgId/notifications', 7, {
    path: `${inbox}?filter=unread&limit=1`,
    headers,
  })
  const { items, nextCursor } = (await page.json()) as {
    items: { id: string }[]
    nextCursor: string | null
  }
  expect(nextCursor).toBeTruthy()
  const read = await probe('POST /api/orgs/:orgId/notifications/:notificationId/read', 7, {
    path: `${inbox}/${items[0]!.id}/read`,
    headers,
    body: {},
  })
  expect(await read.json()).toMatchObject({ ok: true })
  const all = await probe('POST /api/orgs/:orgId/notifications/read-all', 7, {
    path: `${inbox}/read-all`,
    headers,
    body: {},
  })
  expect(await all.json()).toMatchObject({ ok: true, updated: 1 })
}

async function measureRules(probe: Probe, headers: HeadersInit, staffHeaders: HeadersInit) {
  const selector = { kind: 'type', value: notificationType }
  const body = { selector, channel: 'email', enabled: false }
  const adminRule = { ...body, enabled: true, locked: false }
  const orgRules = `${orgPath}/notification-rules`

  await expectRow(await probe('GET /api/notification-types', 1, { headers }), {
    type: notificationType,
  })
  const userRule = await notificationRuleId(
    await probe('PUT /api/me/notification-rules', 2, { headers, body }),
  )
  await expectRow(await probe('GET /api/me/notification-rules', 2, { headers }), { id: userRule })

  const platformRule = await notificationRuleId(
    await probe('PUT /api/platform/notification-rules', 2, { body: adminRule }),
  )
  await expectRow(await probe('GET /api/platform/notification-rules', 2), { id: platformRule })

  const orgRule = await notificationRuleId(
    await probe('PUT /api/orgs/:orgId/notification-rules', 2, {
      path: orgRules,
      headers: staffHeaders,
      body: adminRule,
    }),
  )
  await expectRow(
    await probe('GET /api/orgs/:orgId/notification-rules', 2, {
      path: orgRules,
      headers: staffHeaders,
    }),
    { id: orgRule },
  )

  await expectRow(
    await probe('GET /api/orgs/:orgId/notifications/effective-rules', 9, {
      path: `${inbox}/effective-rules`,
      headers,
    }),
    {
      type: notificationType,
      channel: 'email',
      enabled: false,
      source: { level: 'user', selector },
    },
  )

  await probe('DELETE /api/me/notification-rules/:ruleId', 2, {
    path: `/api/me/notification-rules/${userRule}`,
    headers,
  })
  await probe('DELETE /api/orgs/:orgId/notification-rules/:ruleId', 2, {
    path: `${orgRules}/${orgRule}`,
    headers: staffHeaders,
  })
  await probe('DELETE /api/platform/notification-rules/:ruleId', 2, {
    path: `/api/platform/notification-rules/${platformRule}`,
  })
}

async function measureAdministration(probe: Probe, headers: Record<string, string>) {
  const email = 'd1-budget-user@kit.local'
  const created = await probe('POST /api/admin/users', 13, {
    headers,
    status: 201,
    body: { email, memberships: [{ orgId, role: 'member' }] },
  })
  const { user, welcomeEmailSent } = (await created.json()) as {
    user: { id: string; email: string }
    welcomeEmailSent: boolean
  }
  expect(user.email).toBe(email)
  expect(welcomeEmailSent).toBe(true)
  await expectRow(await probe('GET /api/admin/users', 5, { headers }), { id: user.id })
  await probe('POST /api/admin/users/:id/resend-welcome', 8, {
    path: `/api/admin/users/${user.id}/resend-welcome`,
    headers,
  })

  const permission = { role: 'staff', read: true, write: true }
  await probe('PATCH /api/admin/impersonation/permissions', 3, { body: permission })
  const permissions = await probe('GET /api/admin/impersonation/permissions', 2)
  expect(await permissions.json()).toMatchObject({
    permissions: expect.arrayContaining([permission]),
  })
  const started = await probe('POST /api/impersonation/start', 3, {
    headers: { ...headers, 'X-Impersonation-Id': 'none' },
    body: { organizationId: orgId, subjectUserId: memberId, mode: 'write' },
  })
  const { impersonation } = (await started.json()) as { impersonation: { id: string } }
  const stopped = await probe('POST /api/impersonation/stop', 3, {
    headers: { ...headers, 'X-Impersonation-Id': impersonation.id },
    body: { impersonationId: impersonation.id },
  })
  expect(await stopped.json()).toMatchObject({ stopped: true })

  await expectRow(await probe('GET /api/admin/audit-events', 2), {
    action: 'impersonation.stopped',
    targetId: memberId,
    orgId,
  })
}

export async function measureNotificationsAndAdmin(record: Set<string>) {
  const { app, env, db, probe } = await createRouteFixture(record)
  const staff = await loginCookie(app, env, 'staff@kit.local', TENANCY_PASSWORD)
  const member = await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD)
  const staffHeaders = sessionHeaders(staff, orgId)
  const memberHeaders = sessionHeaders(member, orgId)
  const deliveryId = await seedInbox(app, env, db, staffHeaders)

  await measureInbox(probe, memberHeaders)
  await measureRules(probe, memberHeaders, staffHeaders)
  const delivery = { id: deliveryId, status: 'failed' }
  await expectRow(
    await probe('GET /api/orgs/:orgId/notification-deliveries', 2, {
      path: `${orgPath}/notification-deliveries?status=failed`,
      headers: staffHeaders,
    }),
    delivery,
  )
  await expectRow(await probe('GET /api/platform/notification-deliveries', 2), {
    ...delivery,
    orgId,
  })
  await measureAdministration(probe, sessionHeaders(staff))
}
