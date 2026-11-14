import * as platformModulesRepo from '@kit/auth/repos/platform-modules'
import { AppError } from '@kit/core'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import {
  INTEGRATION_CONFIG_PATHS,
  isModuleConfigured,
  type ModulePublicState,
} from '../lib/integration-config'
import {
  isKitModuleId,
  KIT_MODULE_DEFAULTS,
  KIT_MODULE_IDS,
  type KitModuleId,
} from '../lib/kit-modules'

type Db = DrizzleD1Database<typeof schema>

/** Ensure registry modules exist on platform_modules (idempotent). */
export async function ensurePlatformModules(db: Db): Promise<void> {
  const now = Date.now()
  for (const mod of KIT_MODULE_DEFAULTS) {
    const row = await platformModulesRepo.getPlatformModule(db, mod.id)
    if (row) continue
    await platformModulesRepo.upsertPlatformModule(db, {
      moduleId: mod.id,
      available: false,
      configJson: null,
      updatedAt: now,
    })
  }
}

export async function listPlatformPublic(db: Db, options?: { readOnly?: boolean }) {
  if (!options?.readOnly) await ensurePlatformModules(db)
  const rows = await platformModulesRepo.listPlatformModules(db)
  const byId = new Map(rows.map((r) => [r.moduleId, r]))
  return Object.fromEntries(
    KIT_MODULE_IDS.map((id) => {
      const row = byId.get(id)
      return [
        id,
        {
          available: Boolean(row?.available),
          configured: isModuleConfigured(id, row?.configJson ?? null),
          configPath: INTEGRATION_CONFIG_PATHS[id],
        },
      ]
    }),
  )
}

export async function setPlatformAvailable(db: Db, moduleId: string, available: boolean) {
  if (!isKitModuleId(moduleId)) throw AppError.notFound('Unknown module')
  await ensurePlatformModules(db)
  const row = await platformModulesRepo.getPlatformModule(db, moduleId)
  if (!row) throw AppError.notFound('Unknown module')
  if (available && !isModuleConfigured(moduleId, row.configJson)) {
    throw AppError.integrationNotConfigured(
      'Configure the integration before making this module available',
      { moduleId, configPath: INTEGRATION_CONFIG_PATHS[moduleId] },
    )
  }
  await platformModulesRepo.setPlatformAvailable(db, moduleId, available, Date.now())
}

export async function getOrgModulesEffective(
  db: Db,
  organizationId: string,
  options?: { readOnly?: boolean },
) {
  if (!options?.readOnly) await ensurePlatformModules(db)
  const platform = await platformModulesRepo.listPlatformModules(db)
  const orgRows = await platformModulesRepo.listOrgModules(db, organizationId)
  const orgById = new Map(orgRows.map((r) => [r.moduleId, r]))
  const platformById = new Map(platform.map((r) => [r.moduleId, r]))

  return Object.fromEntries(
    KIT_MODULE_IDS.map((id) => {
      const p = platformById.get(id)
      const o = orgById.get(id)
      const available = Boolean(p?.available)
      const enabled = Boolean(o?.enabled)
      const locked = Boolean(o?.locked)
      const configured = isModuleConfigured(id, p?.configJson ?? null)
      const effective: ModulePublicState & {
        available: boolean
        locked: boolean
        effective: boolean
      } = {
        enabled,
        configured,
        configPath: INTEGRATION_CONFIG_PATHS[id],
        available,
        locked,
        effective: available && enabled,
      }
      return [id, effective]
    }),
  ) as Record<
    KitModuleId,
    ModulePublicState & { available: boolean; locked: boolean; effective: boolean }
  >
}

export async function setOrgModuleEnabled(
  db: Db,
  organizationId: string,
  moduleId: string,
  enabled: boolean,
) {
  if (!isKitModuleId(moduleId)) throw AppError.notFound('Unknown module')
  await ensurePlatformModules(db)
  const platform = await platformModulesRepo.getPlatformModule(db, moduleId)
  if (!platform?.available) {
    throw AppError.forbidden('Module is not available on the platform')
  }
  if (enabled && !isModuleConfigured(moduleId, platform.configJson)) {
    throw AppError.integrationNotConfigured(
      'Configure the integration before enabling this module',
      { moduleId, configPath: INTEGRATION_CONFIG_PATHS[moduleId] },
    )
  }
  const existing = await platformModulesRepo.getOrgModule(db, organizationId, moduleId)
  if (existing?.locked) {
    throw AppError.forbidden('Module is locked for this organization')
  }
  await platformModulesRepo.upsertOrgModule(db, {
    organizationId,
    moduleId,
    enabled,
    // preserve locked/configJson via repo partial update
    updatedAt: Date.now(),
  })
}

export async function isModuleEffective(
  db: Db,
  organizationId: string,
  moduleId: KitModuleId,
): Promise<boolean> {
  const platform = await platformModulesRepo.getPlatformModule(db, moduleId)
  if (!platform?.available) return false
  const org = await platformModulesRepo.getOrgModule(db, organizationId, moduleId)
  return Boolean(org?.enabled)
}
