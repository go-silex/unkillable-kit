/**
 * ADR-0003 Phase B — custom roles + grants + IDOR matrix (CP-IDOR ≥ 8).
 * go-silex/silex-boilerplate#22
 */
import { createDb } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { schema } from './db/schema'
import { seedTenancyDemo } from './seed/seed-tenancy'
import { loginCookie } from './test/api-fixture'
import { hashFixtureCredential } from './test/fixture-credential'
import { createMemoryEnv } from './test/memory-env'

const BA_ENV = {
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  ALLOW_PUBLIC_SIGNUP: 'true',
  ENVIRONMENT: 'test',
}

const ORIGIN = 'http://localhost:5173'

async function seedEnv() {
  const app = createApp()
  const env = createMemoryEnv(BA_ENV)
  const db = createDb(env.DB as unknown as D1Database, schema)
  await seedTenancyDemo(db, { environment: 'test', force: true }, hashFixtureCredential)
  return { app, env, db }
}

describe('org roles Phase B — IDOR + grants', () => {
  it('1 roles list requires auth', async () => {
    const app = createApp()
    const env = createMemoryEnv(BA_ENV)
    const res = await app.request('/api/orgs/org_team/roles', {}, env)
    expect(res.status).toBe(401)
  })

  it('2 owner lists seeded system roles', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/roles',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      roles: Array<{ key: string; isSystem: boolean; grants: unknown[] }>
    }
    const keys = body.roles.map((r) => r.key).sort()
    expect(keys).toEqual(['admin', 'member', 'owner', 'reader'])
    expect(body.roles.every((r) => r.isSystem)).toBe(true)
    expect(body.roles.find((r) => r.key === 'reader')?.grants.length).toBeGreaterThan(0)
  })

  it('3 cross-org IDOR: acme staff cannot list team roles', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'staff@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/roles',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('4 reader cannot create custom role (403)', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-reader@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'viewer_plus', name: 'Viewer+' }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('5 owner creates custom role with read grant', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          key: 'analyst',
          name: 'Analyst',
          grants: [{ moduleId: 'demo', access: 'read' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { role: { key: string; isSystem: boolean } }
    expect(body.role.key).toBe('analyst')
    expect(body.role.isSystem).toBe(false)
  })

  it('6 system role grants are immutable', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const list = await app.request(
      '/api/orgs/org_team/roles',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    const roles = ((await list.json()) as { roles: Array<{ id: string; key: string }> }).roles
    const reader = roles.find((r) => r.key === 'reader')!
    const res = await app.request(
      `/api/orgs/org_team/roles/${reader.id}/grants/demo`,
      {
        method: 'PATCH',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ access: 'write' }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('7 cannot patch grants on other org role id', async () => {
    const { app, env } = await seedEnv()
    const ownerTeam = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const create = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: {
          cookie: ownerTeam,
          Origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          key: 'temp_role',
          name: 'Temp',
          grants: [{ moduleId: 'demo', access: 'read' }],
        }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const roleId = ((await create.json()) as { role: { id: string } }).role.id

    const solo = await loginCookie(app, env, 'solo@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      `/api/orgs/org_solo/roles/${roleId}/grants/demo`,
      {
        method: 'PATCH',
        headers: { cookie: solo, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ access: 'write' }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('8 cannot delete system role', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const list = await app.request(
      '/api/orgs/org_team/roles',
      { headers: { cookie, Origin: ORIGIN } },
      env,
    )
    const ownerRole = (
      (await list.json()) as { roles: Array<{ id: string; key: string }> }
    ).roles.find((r) => r.key === 'owner')!
    const res = await app.request(
      `/api/orgs/org_team/roles/${ownerRole.id}`,
      {
        method: 'DELETE',
        headers: { cookie, Origin: ORIGIN },
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('9 super_admin write on roles routes is denied without membership', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(app, env, 'super@kit.local', 'demo-password-change-me', ORIGIN)
    const res = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'x', name: 'X' }),
      },
      env,
    )
    // Super without membership + write: requireOrgContext fail-closed → 404
    expect(res.status).toBe(404)
  })

  it('10 create role rejects system key reuse', async () => {
    const { app, env } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const res = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'admin', name: 'Fake Admin' }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })

  it('11 delete custom role still assigned → 409', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const create = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          key: 'assigned_role',
          name: 'Assigned',
          grants: [{ moduleId: 'demo', access: 'read' }],
        }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const roleId = ((await create.json()) as { role: { id: string; key: string } }).role.id
    // Point reader membership at custom role
    const { baMember } = await import('@kit/auth/schema')
    const { eq } = await import('drizzle-orm')
    await db
      .update(baMember)
      .set({ role: 'assigned_role' })
      .where(eq(baMember.userId, 'user_team_reader'))
      .run()
    const res = await app.request(
      `/api/orgs/org_team/roles/${roleId}`,
      { method: 'DELETE', headers: { cookie, Origin: ORIGIN } },
      env,
    )
    expect(res.status).toBe(409)
  })

  it('12 resolveModuleAccess denies reader write when grant is read', async () => {
    const { db } = await seedEnv()
    const { ensureSystemRoles, resolveModuleAccess } = await import('./services/org-roles')
    const platformModulesRepo = await import('@kit/auth/repos/platform-modules')
    await ensureSystemRoles(db, 'org_team')
    await platformModulesRepo.upsertPlatformModule(db, {
      moduleId: 'demo',
      available: true,
      configJson: null,
      updatedAt: Date.now(),
    })
    await platformModulesRepo.upsertOrgModule(db, {
      organizationId: 'org_team',
      moduleId: 'demo',
      enabled: true,
      locked: false,
      updatedAt: Date.now(),
    })
    const readOk = await resolveModuleAccess(db, {
      organizationId: 'org_team',
      roleKey: 'reader',
      moduleId: 'demo',
      op: 'read',
    })
    const writeOk = await resolveModuleAccess(db, {
      organizationId: 'org_team',
      roleKey: 'reader',
      moduleId: 'demo',
      op: 'write',
    })
    expect(readOk).toBe(true)
    expect(writeOk).toBe(false)
  })

  it('13 custom role with write cannot be used to assign system admin', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    const create = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          key: 'power_custom',
          name: 'Power',
          grants: [{ moduleId: 'demo', access: 'write' }],
        }),
      },
      env,
    )
    expect(create.status).toBe(201)
    const { assertAssignableRole } = await import('./services/org-roles')
    // Actor is custom with write — must not mint system admin
    await expect(
      assertAssignableRole(db, 'org_team', 'admin', 'power_custom'),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('14 grant ceiling: cannot create role stronger than demoted actor', async () => {
    const { app, env, db } = await seedEnv()
    const cookie = await loginCookie(
      app,
      env,
      'team-owner@kit.local',
      'demo-password-change-me',
      ORIGIN,
    )
    // Demote owner system grant to read so ceiling can fire
    const { ensureSystemRoles } = await import('./services/org-roles')
    const orgRolesRepo = await import('@kit/auth/repos/org-roles')
    await ensureSystemRoles(db, 'org_team')
    const ownerRole = await orgRolesRepo.findRoleByKey(db, 'org_team', 'owner')
    expect(ownerRole).toBeTruthy()
    await orgRolesRepo.upsertGrant(db, {
      organizationId: 'org_team',
      roleId: ownerRole!.id,
      moduleId: 'demo',
      access: 'read',
    })
    const res = await app.request(
      '/api/orgs/org_team/roles',
      {
        method: 'POST',
        headers: { cookie, Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          key: 'too_strong',
          name: 'Too Strong',
          grants: [{ moduleId: 'demo', access: 'write' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })
})
