import { createRequestAuthorization, type ModuleAuthorizationFacts } from '@kit/auth/hono'
import { defineAuthorizationFact } from '@kit/auth/snapshot'
import { KIT_MODULE_IDS } from '../lib/kit-modules'
import type { AppEnv } from '../types'

const availabilityTable = {
  name: 'organization_modules',
  columns: ['organization_id', 'module_id', 'enabled', 'available'],
}
const grantsTable = {
  name: 'organization_role_module_grants',
  columns: ['role_id', 'module_id', 'access'],
}

function grant(moduleId: string, kind: 'organization-role' | 'delegated-role') {
  return defineAuthorizationFact({
    table: grantsTable,
    // Kit joins role_id through organization_roles in the selected organization.
    scope: { kind, roleId: 'role_id' },
    select: ['access'],
    where: { module_id: moduleId },
    maxRows: 1,
    decode: (rows) => rows[0]?.access ?? null,
  })
}

const modules = new Map<string, ModuleAuthorizationFacts>(
  KIT_MODULE_IDS.map((id) => [
    id,
    {
      availability: defineAuthorizationFact({
        table: availabilityTable,
        scope: { kind: 'organization', organizationId: 'organization_id' },
        select: ['enabled', 'available'],
        where: { module_id: id },
        maxRows: 1,
        decode: (rows) => rows[0] ?? null,
      }),
      grant: grant(id, 'organization-role'),
      delegatedGrant: grant(id, 'delegated-role'),
    },
  ]),
)

export const authorization: ReturnType<typeof createRequestAuthorization<AppEnv>> =
  createRequestAuthorization<AppEnv>({
    db: (c) => c.env.DB,
    auth: (c) => c.get('betterAuth'),
    delegation: true,
    moduleFacts: (id) => modules.get(id),
  })
