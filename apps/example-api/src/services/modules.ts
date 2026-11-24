import * as platformModulesRepo from '@kit/auth/repos/platform-modules'
import { AppError } from '@kit/core'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import {
  INTEGRATION_CONFIG_PATHS,
  isModuleConfigured,
  type ModulePublicState,
} from '../lib/integration-config'
import { isKitModuleId, type KitModuleId } from '../lib/kit-modules'
import * as platformModulesService from './platform-modules'

type Db = DrizzleD1Database<typeof schema>

/** platform_modules is the only catalogue (ADR-0003 D7); a missing row is unavailable. */
async function readModuleRow(db: Db, id: KitModuleId) {
  const platform = await platformModulesRepo.getPlatformModule(db, id)
  return {
    enabled: Boolean(platform?.available),
    configJson: platform?.configJson ?? null,
  }
}

export async function getModulesState(db: Db): Promise<Record<KitModuleId, ModulePublicState>> {
  const rows = await platformModulesService.listPlatformPublic(db)
  return Object.fromEntries(
    Object.entries(rows).map(([id, { available, ...state }]) => [
      id,
      { enabled: available, ...state },
    ]),
  ) as Record<KitModuleId, ModulePublicState>
}

export async function isModuleEnabled(db: Db, id: KitModuleId): Promise<boolean> {
  const row = await readModuleRow(db, id)
  return row.enabled
}

export async function setModuleEnabled(db: Db, id: string, enabled: boolean): Promise<void> {
  if (!isKitModuleId(id)) {
    throw AppError.notFound('Unknown module')
  }
  await platformModulesService.ensurePlatformModules(db)
  const row = await readModuleRow(db, id)
  if (enabled && !isModuleConfigured(id, row.configJson)) {
    throw AppError.integrationNotConfigured(
      'Configure the integration before enabling this module',
      { moduleId: id, configPath: INTEGRATION_CONFIG_PATHS[id] },
    )
  }
  const now = Date.now()
  await platformModulesRepo.upsertPlatformModule(db, {
    moduleId: id,
    available: enabled,
    configJson: row.configJson,
    updatedAt: now,
  })
}
