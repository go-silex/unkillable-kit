import { listMembershipsForUser } from '@kit/auth/repos/orgs'
import { getPlatformRole } from '@kit/auth/repos/platform-roles'
import { baUser } from '@kit/auth/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { requireAuth } from './auth'
import type { AppEnv } from './types'

export const me = new Hono<AppEnv>()
me.get('/api/me', requireAuth, async (c) => {
  const db = c.get('db')!
  const subject = c.get('subject')!
  const [user] = await db.select().from(baUser).where(eq(baUser.id, subject)).limit(1)
  const memberships = await listMembershipsForUser(db, subject)
  const keyOrg = c.get('keyOrganizationId')
  const orgs = memberships
    .filter((m) => c.get('authMethod') !== 'api_key' || m.organizationId === keyOrg)
    .map((m) => ({
      id: m.organizationId,
      name: m.orgName,
      slug: m.orgSlug,
      kind: m.orgKind,
      status: m.orgStatus,
      role: m.role,
    }))
  return c.json({
    subject,
    email: user?.email,
    name: user?.name,
    authMethod: c.get('authMethod'),
    platformRole: await getPlatformRole(db, subject),
    orgs,
    impersonation: null,
    impersonationPermissions: { read: false, write: false },
    requestId: c.get('requestId'),
  })
})
