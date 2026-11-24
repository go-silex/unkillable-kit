import type { ImpersonationInfo } from '@kit/api-client/me'
import { createDb } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { schema } from '../db/schema'
import { seedDemoDatabase } from '../seed/seed-db'
import { hashFixtureCredential } from '../test/fixture-credential'
import { createMemoryEnv } from '../test/memory-env'
import { getMeProfile } from './me'

describe('getMeProfile (D11 api_key org filter)', () => {
  async function seededDb() {
    const env = createMemoryEnv({ ENVIRONMENT: 'test' })
    const db = createDb(env.DB as unknown as D1Database, schema)
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    return db
  }

  it('api_key without keyOrganizationId → orgs=[] (fail-closed)', async () => {
    const db = await seededDb()
    // staff has org_acme + org_beta memberships under session; unbound key must not leak them
    const profile = await getMeProfile(db, 'user_staff', {
      authMethod: 'api_key',
      platformRole: 'staff',
    })
    expect(profile.orgs).toEqual([])
    expect(profile.email).toBe('staff@kit.local')
  })

  it('api_key with null keyOrganizationId → orgs=[]', async () => {
    const db = await seededDb()
    const profile = await getMeProfile(db, 'user_staff', {
      authMethod: 'api_key',
      platformRole: 'staff',
      keyOrganizationId: null,
    })
    expect(profile.orgs).toEqual([])
  })

  it('api_key with keyOrganizationId filters to that org only', async () => {
    const db = await seededDb()
    const profile = await getMeProfile(db, 'user_staff', {
      authMethod: 'api_key',
      platformRole: 'staff',
      keyOrganizationId: 'org_acme',
    })
    expect(profile.orgs).toHaveLength(1)
    expect(profile.orgs[0]!.id).toBe('org_acme')
  })

  it('session auth returns full membership catalogue (not filtered)', async () => {
    const db = await seededDb()
    const profile = await getMeProfile(db, 'user_staff', {
      authMethod: 'session',
      platformRole: 'staff',
    })
    const ids = profile.orgs.map((o) => o.id).sort()
    expect(ids).toEqual(['org_acme', 'org_beta'])
  })
})

describe('getMeProfile impersonation', () => {
  const info: ImpersonationInfo = {
    id: 'imp_1',
    mode: 'read',
    organizationId: 'org_acme',
    actor: { id: 'user_staff', name: 'Staff Agent' },
    subject: { id: 'user_team_owner', name: 'Target', email: 'target@example.com' },
    startedAt: 123,
    active: true,
  }

  async function seededDb() {
    const env = createMemoryEnv({ ENVIRONMENT: 'test' })
    const db = createDb(env.DB as unknown as D1Database, schema)
    await seedDemoDatabase(db, { notes: false, environment: 'test' }, hashFixtureCredential)
    return db
  }

  it('returns the pinned target profile and admitted actor permissions', async () => {
    const db = await seededDb()
    const profile = await getMeProfile(db, info.subject.id, {
      authMethod: 'session',
      platformRole: null,
      impersonation: info,
      impersonationPermissions: { read: true, write: false },
    })
    expect(profile.platformRole).toBeNull()
    expect(profile.orgs.map((org) => org.id)).toEqual(['org_acme'])
    expect(profile.impersonation).toEqual(info)
    expect(profile.impersonationPermissions).toEqual({ read: true, write: false })
  })

  it('returns a recovery-only profile when delegation is inactive', async () => {
    const db = await seededDb()
    const profile = await getMeProfile(db, info.subject.id, {
      authMethod: 'session',
      platformRole: null,
      impersonation: { ...info, active: false },
    })
    expect(profile.platformRole).toBeNull()
    expect(profile.orgs).toEqual([])
    expect(profile.name).toBeUndefined()
    expect(profile.email).toBeUndefined()
    expect(profile.impersonation?.subject).toEqual({ id: info.subject.id })
    expect(profile.impersonation?.active).toBe(false)
  })

  it('does not expose session-only capabilities to an API key', async () => {
    const db = await seededDb()
    const profile = await getMeProfile(db, 'user_staff', {
      authMethod: 'api_key',
      platformRole: 'staff',
      impersonationPermissions: { read: true, write: true },
    })
    expect(profile.impersonation).toBeNull()
    expect(profile.impersonationPermissions).toEqual({ read: false, write: false })
  })
})
