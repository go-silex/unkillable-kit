import { OpenAPIHono } from '@hono/zod-openapi'
import { baOrganization } from '@kit/auth/schema'
import { AppError } from '@kit/core'
import { sql } from 'drizzle-orm'
import { resolveEmailPort } from '../lib/email-port'
import { invalidRequest } from '../lib/openapi'
import { corsAllowlist } from '../lib/session-env'
import { authorization } from '../middleware/authorization'
import * as invitationsService from '../services/invitations'
import * as orgRolesService from '../services/org-roles'
import * as orgsService from '../services/orgs'
import * as platformModulesService from '../services/platform-modules'
import type { AppEnv } from '../types'
import {
  cancelInvitation,
  createInvitation,
  createOrg,
  getOrg,
  listInvitations,
  listMembers,
  listOrgs,
} from './orgs.schemas'
import {
  listOrgModules,
  listPlatformModules,
  patchOrgModule,
  patchPlatformModule,
} from './orgs-modules.schemas'
import { createRole, deleteRole, listRoles, patchRoleGrant } from './orgs-roles.schemas'

export const orgsRoutes = new OpenAPIHono<AppEnv>()

orgsRoutes.openapi(listOrgs, async (c) => {
  const db = c.get('db')!
  const subject = c.get('subject')!
  let orgs = await orgsService.listOrgsForSubject(db, subject)
  // D11 — api_key fail-closed: missing key org → empty list (never full membership catalogue)
  const keyOrg = c.get('keyOrganizationId')
  if (c.get('authMethod') === 'api_key') {
    orgs = keyOrg ? orgs.filter((o) => o.id === keyOrg) : []
  }
  return c.json({ orgs, requestId: c.get('requestId') })
})

orgsRoutes.openapi(
  createOrg,
  async (c) => {
    const data = c.req.valid('json')
    const db = c.get('db')!
    const org = await orgsService.createOrganization(db, {
      name: data.name,
      slug: data.slug,
      kind: 'client',
      ownerUserId: c.get('subject')!,
    })
    c.header('Location', `/api/orgs/${org.id}`)
    return c.json({ org, requestId: c.get('requestId') }, 201)
  },
  invalidRequest('Invalid organization payload'),
)

orgsRoutes.openapi(getOrg, async (c) => {
  const admitted = authorization.view(c).organization!
  const { id, kind, status, role, bypass } = admitted
  const { name, slug, logo, metadata, createdAt, updatedAt } = baOrganization
  // Product detail, scoped to the already admitted Organization. Do not reread Kit facts.
  try {
    const detail = await c
      .get('db')!
      .select({ name, slug, logo, metadata, createdAt, updatedAt })
      .from(baOrganization)
      .where(
        sql`typeof(${baOrganization.id}) = 'text' and ${baOrganization.id} = ${id} collate binary`,
      )
      .get()
    if (!detail) throw new Error('Admitted organization detail missing')
    const org = {
      ...detail,
      id,
      kind,
      status,
      role,
      bypass,
      createdAt: detail.createdAt.toISOString(),
      updatedAt: detail.updatedAt?.toISOString() ?? null,
    }
    return c.json({ org, requestId: c.get('requestId') })
  } catch {
    throw new AppError('INTERNAL_ERROR', 'Authorization unavailable', 503)
  }
})

orgsRoutes.openapi(listMembers, async (c) => {
  const db = c.get('db')!
  const members = await orgsService.listOrgMembers(db, c.get('orgId')!)
  return c.json({ members, requestId: c.get('requestId') })
})

orgsRoutes.openapi(
  createInvitation,
  async (c) => {
    const orgRole = c.get('orgRole')
    if (!orgRole) {
      throw AppError.forbidden('Organization membership required')
    }
    const data = c.req.valid('json')
    const allowedOrigins = corsAllowlist(c.env)
    const acceptBaseUrl = allowedOrigins[0]
    const invitation = await invitationsService.createInvitation(c.get('db')!, {
      orgId: c.get('orgId')!,
      inviterUserId: c.get('subject')!,
      inviterOrgRole: orgRole,
      email: data.email,
      role: data.role,
      acceptBaseUrl,
      allowedOrigins,
      emailPort: resolveEmailPort(c.env),
      requestId: c.get('requestId'),
    })
    c.header('Location', `/api/orgs/${c.get('orgId')}/invitations/${invitation.id}`)
    return c.json({ invitation, requestId: c.get('requestId') }, 201)
  },
  invalidRequest('Invalid invitation payload'),
)

orgsRoutes.openapi(listInvitations, async (c) => {
  const { status: statusParam } = c.req.valid('query')
  const status =
    statusParam === 'accepted' || statusParam === 'canceled' || statusParam === 'pending'
      ? statusParam
      : 'pending'
  const invitations = await invitationsService.listInvitations(
    c.get('db')!,
    c.get('orgId')!,
    status,
  )
  return c.json({ invitations, requestId: c.get('requestId') })
})

orgsRoutes.openapi(cancelInvitation, async (c) => {
  await invitationsService.cancelInvitation(
    c.get('db')!,
    c.get('orgId')!,
    c.req.valid('param').invitationId,
  )
  return c.json({ ok: true, requestId: c.get('requestId') })
})

orgsRoutes.openapi(listOrgModules, async (c) => {
  const db = c.get('db')!
  const modules = await platformModulesService.getOrgModulesEffective(db, c.get('orgId')!)
  return c.json({ modules, requestId: c.get('requestId') })
})

orgsRoutes.openapi(
  patchOrgModule,
  async (c) => {
    const data = c.req.valid('json')
    const db = c.get('db')!
    await platformModulesService.setOrgModuleEnabled(
      db,
      c.get('orgId')!,
      c.req.valid('param').moduleId,
      data.enabled,
    )
    const modules = await platformModulesService.getOrgModulesEffective(db, c.get('orgId')!)
    return c.json({ modules, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid module payload'),
)

orgsRoutes.openapi(listRoles, async (c) => {
  const db = c.get('db')!
  const roles = await orgRolesService.listRolesWithGrants(db, c.get('orgId')!)
  return c.json({ roles, requestId: c.get('requestId') })
})

orgsRoutes.openapi(
  createRole,
  async (c) => {
    const orgRole = c.get('orgRole')
    if (!orgRole) throw AppError.forbidden('Organization role required')
    const data = c.req.valid('json')
    const db = c.get('db')!
    const role = await orgRolesService.createCustomRole(db, {
      organizationId: c.get('orgId')!,
      key: data.key,
      name: data.name,
      grants: data.grants,
      actorRoleKey: orgRole,
    })
    return c.json({ role, requestId: c.get('requestId') }, 201)
  },
  invalidRequest('Invalid role payload'),
)

orgsRoutes.openapi(
  patchRoleGrant,
  async (c) => {
    const orgRole = c.get('orgRole')
    if (!orgRole) throw AppError.forbidden('Organization role required')
    const data = c.req.valid('json')
    const { roleId, moduleId } = c.req.valid('param')
    const db = c.get('db')!
    const role = await orgRolesService.setRoleGrant(db, {
      organizationId: c.get('orgId')!,
      roleId,
      moduleId,
      access: data.access,
      actorRoleKey: orgRole,
    })
    return c.json({ role, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid grant payload'),
)

orgsRoutes.openapi(deleteRole, async (c) => {
  const db = c.get('db')!
  await orgRolesService.deleteCustomRole(db, c.get('orgId')!, c.req.valid('param').roleId)
  return c.json({ ok: true, requestId: c.get('requestId') })
})

orgsRoutes.openapi(listPlatformModules, async (c) => {
  const db = c.get('db')!
  const modules = await platformModulesService.listPlatformPublic(db)
  return c.json({ modules, requestId: c.get('requestId') })
})

orgsRoutes.openapi(
  patchPlatformModule,
  async (c) => {
    const data = c.req.valid('json')
    const db = c.get('db')!
    await platformModulesService.setPlatformAvailable(
      db,
      c.req.valid('param').moduleId,
      data.available,
    )
    const modules = await platformModulesService.listPlatformPublic(db)
    return c.json({ modules, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid platform module payload'),
)
