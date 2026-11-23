import { expect } from 'vitest'
import { TENANCY_PASSWORD } from '../seed/tenancy-data'
import { mintApiKey } from '../services/auth'
import { bearerHeaders, loginCookie, sessionHeaders } from './api-fixture'
import { createRouteFixture } from './d1-route-fixture'

const TEAM_ID = 'org_team'
const team = `/api/orgs/${TEAM_ID}`
const inviteeEmail = 'solo@kit.local'

export async function measureOrganizations(record: Set<string>) {
  const { app, env, db, probe } = await createRouteFixture(record)
  const owner = sessionHeaders(
    await loginCookie(app, env, 'team-owner@kit.local', TENANCY_PASSWORD),
  )
  const invitee = sessionHeaders(await loginCookie(app, env, inviteeEmail, TENANCY_PASSWORD))
  const { key } = await mintApiKey(db, 'user_team_owner', {
    organizationId: TEAM_ID,
    scopes: ['read', 'admin'],
  })
  const apiKey = { headers: bearerHeaders(key, TEAM_ID), variant: 'api-key' }

  await probe('GET /api/orgs', 15, { headers: owner })
  await probe('GET /api/orgs', 14, apiKey)
  await probe('POST /api/orgs', 71, {
    headers: owner,
    body: { name: 'Budget Organization', slug: 'budget-organization' },
    status: 201,
  })
  await probe('GET /api/orgs/:orgId', 12, { path: team, headers: owner })
  await probe('GET /api/orgs/:orgId', 11, { ...apiKey, path: team })
  await probe('GET /api/orgs/:orgId/members', 11, { path: `${team}/members`, headers: owner })
  await probe('GET /api/orgs/:orgId/members', 10, { ...apiKey, path: `${team}/members` })

  // Provision a new recipient on the measured create path; acceptance uses an existing login.
  const createInvite = await probe('POST /api/orgs/:orgId/invitations', 33, {
    path: `${team}/invitations`,
    headers: owner,
    body: { email: 'budget-invitee@kit.local', role: 'member' },
    status: 201,
  })
  const { invitation } = (await createInvite.json()) as { invitation: { id: string } }
  const listInvites = await probe('GET /api/orgs/:orgId/invitations', 11, {
    path: `${team}/invitations?status=pending`,
    headers: owner,
  })
  expect(await listInvites.json()).toMatchObject({
    invitations: [{ id: invitation.id, status: 'pending' }],
  })
  const listKeyInvites = await probe('GET /api/orgs/:orgId/invitations', 10, {
    ...apiKey,
    path: `${team}/invitations?status=pending`,
  })
  expect(await listKeyInvites.json()).toMatchObject({
    invitations: [{ id: invitation.id, status: 'pending' }],
  })
  await probe('DELETE /api/orgs/:orgId/invitations/:invitationId', 12, {
    path: `${team}/invitations/${invitation.id}`,
    headers: owner,
  })

  const inviteExistingUser = await app.request(
    `${team}/invitations`,
    {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ email: inviteeEmail, role: 'member' }),
    },
    env,
  )
  expect(inviteExistingUser.status).toBe(201)
  const { invitation: pending } = (await inviteExistingUser.json()) as {
    invitation: { id: string }
  }
  const accept = await probe('POST /api/invitations/:invitationId/accept', 19, {
    path: `/api/invitations/${pending.id}/accept`,
    headers: invitee,
  })
  expect(await accept.json()).toMatchObject({
    membership: { organizationId: TEAM_ID, role: 'member' },
  })

  await probe('GET /api/orgs/:orgId/roles', 23, { path: `${team}/roles`, headers: owner })
  await probe('GET /api/orgs/:orgId/roles', 22, { ...apiKey, path: `${team}/roles` })
  const createRole = await probe('POST /api/orgs/:orgId/roles', 46, {
    path: `${team}/roles`,
    headers: owner,
    body: { key: 'analyst', name: 'Analyst', grants: [{ moduleId: 'demo', access: 'read' }] },
    status: 201,
  })
  const { role } = (await createRole.json()) as { role: { id: string } }
  const patchGrant = await probe('PATCH /api/orgs/:orgId/roles/:roleId/grants/:moduleId', 46, {
    path: `${team}/roles/${role.id}/grants/demo`,
    headers: owner,
    body: { access: 'write' },
  })
  expect(await patchGrant.json()).toMatchObject({
    role: { id: role.id, grants: expect.arrayContaining([{ moduleId: 'demo', access: 'write' }]) },
  })
  await probe('DELETE /api/orgs/:orgId/roles/:roleId', 15, {
    path: `${team}/roles/${role.id}`,
    headers: owner,
  })

  await probe('GET /api/orgs/:orgId/modules', 16, { path: `${team}/modules`, headers: owner })
  await probe('GET /api/orgs/:orgId/modules', 15, { ...apiKey, path: `${team}/modules` })
  await probe('PATCH /api/orgs/:orgId/modules/:moduleId', 24, {
    path: `${team}/modules/demo`,
    headers: owner,
    body: { enabled: false },
  })
  const enableDemo = await probe('PATCH /api/orgs/:orgId/modules/:moduleId', 23, {
    ...apiKey,
    path: `${team}/modules/demo`,
    body: { enabled: true },
  })
  expect(await enableDemo.json()).toMatchObject({ modules: { demo: { effective: true } } })

  await probe('GET /api/platform/modules', 15)
  await probe('PATCH /api/platform/modules/:moduleId', 21, {
    path: '/api/platform/modules/demo',
    body: { available: false },
  })
  await probe('GET /api/modules', 22)
  await probe('PATCH /api/modules/:id', 28, { path: '/api/modules/demo', body: { enabled: true } })
}
