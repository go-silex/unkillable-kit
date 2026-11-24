import { createRoute, z } from '@hono/zod-openapi'
import { type AuthorizationFact, defineAuthorizationFact } from '@kit/auth/snapshot'
import { invitationIdSchema } from '../lib/invitation-id'
import {
  authErrorResponses,
  errorResponse,
  notFoundErrorResponse,
  orgIsolationDescription,
  rateLimitErrorResponse,
  sessionOnlySecurity,
  sessionOrKeySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import { authorization } from '../middleware/authorization'
import { requireOrgCapability, requireOrgContext } from '../middleware/org-context'
import { requireSession } from '../middleware/require-session'

const orgCtx = requireOrgContext()
const orgCtxSuper = requireOrgContext({ allowSuperAdmin: true })
const manageMembers = requireOrgCapability('manage_members')

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(48).optional(),
  // kind is server-forced to client for public create (review fix)
})

const inviteCreateSchema = z
  .object({
    email: z.string().email().max(254),
    /** System invitable keys or org custom role key (Phase B). */
    role: z.string().min(1).max(48),
  })
  .strict()

const orgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    kind: z.string(),
    status: z.string(),
    role: z.string().nullable().optional(),
    bypass: z.boolean().optional(),
  })
  .openapi('Organization')

/** POST /api/orgs 201 — creator is always owner; role is required. */
const createdOrgSchema = orgSchema.omit({ role: true }).extend({
  role: z.string().min(1),
})

const orgMemberSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    role: z.string(),
    createdAt: z.date(),
  })
  .openapi('OrgMember')

const invitationSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    inviterId: z.string(),
  })
  .openapi('Invitation')

export const orgIdParam = z.object({ orgId: z.string().min(1) })
const orgInvitationParams = z.object({
  orgId: z.string().min(1),
  invitationId: invitationIdSchema,
})

export const requestIdField = z.string()
export const conflictResponse = { 409: errorResponse('Conflict') } as const

export const listOrgs = createRoute({
  method: 'get',
  path: '/api/orgs',
  tags: ['orgs'],
  summary: 'List organizations visible to the caller',
  security: sessionOrKeySecurity,
  responses: {
    200: {
      description:
        'Memberships, or the full catalogue for super_admin (api_key is fail-closed to the key org)',
      content: {
        'application/json': {
          schema: z.object({ orgs: z.array(orgSchema), requestId: requestIdField }),
        },
      },
    },
    ...authErrorResponses,
  },
})

export const createOrg = createRoute({
  method: 'post',
  path: '/api/orgs',
  tags: ['orgs'],
  summary: 'Create an organization (session only)',
  security: sessionOnlySecurity,
  middleware: [requireSession] as const,
  request: {
    body: { content: { 'application/json': { schema: createSchema } }, required: true },
  },
  responses: {
    201: {
      description: 'Created organization; `Location` is `/api/orgs/{id}`',
      content: {
        'application/json': {
          schema: z.object({ org: createdOrgSchema, requestId: requestIdField }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...conflictResponse,
  },
})

const organizationRow = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number().nullable(),
  kind: z.string(),
  status: z.string(),
})

type OrganizationDetail = Omit<z.infer<typeof organizationRow>, 'created_at' | 'updated_at'> & {
  createdAt: string
  updatedAt: string | null
}

export const orgDetail: AuthorizationFact<OrganizationDetail> = defineAuthorizationFact({
  table: { name: 'organization', columns: Object.keys(organizationRow.shape) },
  scope: { kind: 'organization', organizationId: 'id' },
  select: Object.keys(organizationRow.shape),
  maxRows: 1,
  decode: ([row]) => {
    const { created_at, updated_at, ...org } = organizationRow.parse(row)
    return {
      ...org,
      createdAt: new Date(created_at).toISOString(),
      updatedAt: updated_at === null ? null : new Date(updated_at).toISOString(),
    }
  },
})

export const getOrg = createRoute({
  method: 'get',
  path: '/api/orgs/{orgId}',
  tags: ['orgs'],
  summary: 'Read one organization',
  description: orgIsolationDescription,
  security: sessionOrKeySecurity,
  middleware: [orgCtxSuper, authorization.includeFacts(orgDetail)] as const,
  request: { params: orgIdParam },
  responses: {
    200: {
      description: 'Organization plus membership role (or super_admin bypass)',
      content: {
        'application/json': {
          schema: z.object({ org: orgSchema, requestId: requestIdField }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

export const listMembers = createRoute({
  method: 'get',
  path: '/api/orgs/{orgId}/members',
  tags: ['orgs'],
  summary: 'List organization members',
  description: orgIsolationDescription,
  security: sessionOrKeySecurity,
  middleware: [orgCtxSuper, manageMembers] as const,
  request: { params: orgIdParam },
  responses: {
    200: {
      description: 'Members of this organization (or super_admin bypass)',
      content: {
        'application/json': {
          schema: z.object({ members: z.array(orgMemberSchema), requestId: requestIdField }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

export const createInvitation = createRoute({
  method: 'post',
  path: '/api/orgs/{orgId}/invitations',
  tags: ['orgs'],
  summary: 'Create an organization invitation (session only)',
  description: orgIsolationDescription,
  security: sessionOnlySecurity,
  middleware: [orgCtx, manageMembers, requireSession] as const,
  request: {
    params: orgIdParam,
    body: { content: { 'application/json': { schema: inviteCreateSchema } }, required: true },
  },
  responses: {
    201: {
      description: 'Created invitation',
      content: {
        'application/json': {
          schema: z.object({ invitation: invitationSchema, requestId: requestIdField }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
    ...conflictResponse,
    ...rateLimitErrorResponse,
  },
})

export const listInvitations = createRoute({
  method: 'get',
  path: '/api/orgs/{orgId}/invitations',
  tags: ['orgs'],
  summary: 'List organization invitations',
  description: `${orgIsolationDescription} Query \`status\` is free-form; unknown values default to pending (not 400).`,
  security: sessionOrKeySecurity,
  middleware: [orgCtx, manageMembers] as const,
  request: {
    params: orgIdParam,
    // Optional string — not an enum — so unknown status still defaults to pending.
    query: z.object({ status: z.string().optional() }),
  },
  responses: {
    200: {
      description: 'Invitations for this org (default status=pending)',
      content: {
        'application/json': {
          schema: z.object({ invitations: z.array(invitationSchema), requestId: requestIdField }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

export const cancelInvitation = createRoute({
  method: 'delete',
  path: '/api/orgs/{orgId}/invitations/{invitationId}',
  tags: ['orgs'],
  summary: 'Cancel a pending invitation (session only)',
  description: orgIsolationDescription,
  security: sessionOnlySecurity,
  middleware: [orgCtx, manageMembers, requireSession] as const,
  request: { params: orgInvitationParams },
  responses: {
    200: {
      description: 'Canceled',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), requestId: requestIdField }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
    ...conflictResponse,
  },
})
