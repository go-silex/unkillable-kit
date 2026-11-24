import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  authErrorResponses,
  invalidRequest,
  notFoundErrorResponse,
  sessionOnlySecurity,
  validationErrorResponse,
} from '../lib/openapi'
import { requirePlatformRole } from '../middleware/org-context'
import { requireAuth } from '../middleware/require-auth'
import { requireSession } from '../middleware/require-session'
import * as modulesService from '../services/modules'
import type { AppEnv } from '../types'

const patchSchema = z.object({
  enabled: z.boolean(),
})

const modulePublicStateSchema = z
  .object({
    enabled: z.boolean(),
    configured: z.boolean(),
    configPath: z.string(),
  })
  .openapi('ModulePublicState')

const modulesStateSchema = z.record(z.string(), modulePublicStateSchema)

const idParamSchema = z.object({ id: z.string().min(1) })

export const modulesRoutes = new OpenAPIHono<AppEnv>()

const platformStaff = requirePlatformRole('super_admin', 'staff')
const platformSuper = requirePlatformRole('super_admin')

modulesRoutes.use('/api/modules', requireAuth)
modulesRoutes.use('/api/modules/*', requireAuth)

const modulesEnvelope = z.object({ modules: modulesStateSchema, requestId: z.string() })

/** Legacy read shape for SPA — maps platform.available → enabled. */
const listModules = createRoute({
  method: 'get',
  path: '/api/modules',
  tags: ['modules'],
  summary: 'List platform module public state (legacy SPA shape)',
  security: sessionOnlySecurity,
  middleware: [platformStaff, requireSession] as const,
  responses: {
    200: {
      description: 'Module map keyed by id; `enabled` mirrors platform.available',
      content: { 'application/json': { schema: modulesEnvelope } },
    },
    ...authErrorResponses,
  },
})

modulesRoutes.openapi(listModules, async (c) => {
  const db = c.get('db')!
  const modules = await modulesService.getModulesState(db)
  return c.json({ modules, requestId: c.get('requestId') })
})

/** Platform catalogue write — super_admin only (was kit demo admin role). */
const patchModule = createRoute({
  method: 'patch',
  path: '/api/modules/{id}',
  tags: ['modules'],
  summary: 'Enable or disable a platform module (super_admin session)',
  security: sessionOnlySecurity,
  middleware: [platformSuper, requireSession] as const,
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: patchSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Updated module map',
      content: { 'application/json': { schema: modulesEnvelope } },
    },
    ...validationErrorResponse,
    ...authErrorResponses,
    ...notFoundErrorResponse,
  },
})

modulesRoutes.openapi(
  patchModule,
  async (c) => {
    const data = c.req.valid('json')
    const db = c.get('db')!
    await modulesService.setModuleEnabled(db, c.req.valid('param').id, data.enabled)
    const modules = await modulesService.getModulesState(db)
    return c.json({ modules, requestId: c.get('requestId') })
  },
  invalidRequest('Invalid module payload'),
)
