import { createRoute, z } from '@hono/zod-openapi'
import {
  authErrorResponses,
  notFoundErrorResponse,
  orgIsolationDescription,
  sessionOnlySecurity,
  sessionOrKeySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import {
  requireOrgCapability,
  requireOrgContext,
  requirePlatformRole,
} from '../middleware/org-context'
import { requireSession } from '../middleware/require-session'
import { orgIdParam, requestIdField } from './orgs.schemas'

const orgCtx = requireOrgContext()
const orgCtxSuper = requireOrgContext({ allowSuperAdmin: true })
const manageModules = requireOrgCapability('manage_modules')
const platformStaff = requirePlatformRole('super_admin', 'staff')
const platformSuper = requirePlatformRole('super_admin')

const patchModuleSchema = z.object({
  enabled: z.boolean(),
})

const orgModuleStateSchema = z
  .object({
    enabled: z.boolean(),
    configured: z.boolean(),
    configPath: z.string(),
    available: z.boolean(),
    locked: z.boolean(),
    effective: z.boolean(),
  })
  .openapi('OrgModuleState')

const platformModuleStateSchema = z
  .object({
    available: z.boolean(),
    configured: z.boolean(),
    configPath: z.string(),
  })
  .openapi('PlatformModuleState')

const orgModuleParams = z.object({
  orgId: z.string().min(1),
  moduleId: z.string().min(1),
})
const moduleIdParam = z.object({ moduleId: z.string().min(1) })

export const listOrgModules = createRoute({
  method: 'get',
  path: '/api/orgs/{orgId}/modules',
  tags: ['orgs'],
  summary: 'List effective org module state',
  description: orgIsolationDescription,
  security: sessionOrKeySecurity,
  middleware: [orgCtxSuper] as const,
  request: { params: orgIdParam },
  responses: {
    200: {
      description: 'Per-module available/enabled/locked/effective flags (or super_admin bypass)',
      content: {
        'application/json': {
          schema: z.object({
            modules: z.record(z.string(), orgModuleStateSchema),
            requestId: requestIdField,
          }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

export const patchOrgModule = createRoute({
  method: 'patch',
  path: '/api/orgs/{orgId}/modules/{moduleId}',
  tags: ['orgs'],
  summary: 'Enable or disable an org module',
  description: orgIsolationDescription,
  security: sessionOrKeySecurity,
  middleware: [orgCtx, manageModules] as const,
  request: {
    params: orgModuleParams,
    body: { content: { 'application/json': { schema: patchModuleSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Updated org module map',
      content: {
        'application/json': {
          schema: z.object({
            modules: z.record(z.string(), orgModuleStateSchema),
            requestId: requestIdField,
          }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

export const listPlatformModules = createRoute({
  method: 'get',
  path: '/api/platform/modules',
  tags: ['platform'],
  summary: 'List platform module catalogue (super_admin or staff session)',
  security: sessionOnlySecurity,
  middleware: [platformStaff, requireSession] as const,
  responses: {
    200: {
      description: 'Platform-level available/configured/configPath per module',
      content: {
        'application/json': {
          schema: z.object({
            modules: z.record(z.string(), platformModuleStateSchema),
            requestId: requestIdField,
          }),
        },
      },
    },
    ...authErrorResponses,
  },
})

export const patchPlatformModule = createRoute({
  method: 'patch',
  path: '/api/platform/modules/{moduleId}',
  tags: ['platform'],
  summary: 'Set platform module availability (super_admin session)',
  security: sessionOnlySecurity,
  middleware: [platformSuper, requireSession] as const,
  request: {
    params: moduleIdParam,
    body: {
      content: { 'application/json': { schema: z.object({ available: z.boolean() }) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated platform module map',
      content: {
        'application/json': {
          schema: z.object({
            modules: z.record(z.string(), platformModuleStateSchema),
            requestId: requestIdField,
          }),
        },
      },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})
