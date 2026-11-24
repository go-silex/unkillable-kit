import { listRolesForOrg } from '@kit/auth/repos/org-roles'
import {
  getPlatformModule,
  listPlatformModules,
  upsertPlatformModule,
} from '@kit/auth/repos/platform-modules'
import { organizationModules, platformModules } from '@kit/auth/schema'
import { createDb } from '@kit/db'
import { FLOWS_MODULE_ID } from '@kit/flows'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { schema } from '../db/schema'
import { isModuleConfigured } from '../lib/integration-config'
import { isKitModuleId, KIT_MODULE_IDS } from '../lib/kit-modules'
import { createMemoryEnv } from '../test/memory-env'
import { ensureSystemRoles, listRolesWithGrants, resolveModuleAccess } from './org-roles'
import * as platformModulesService from './platform-modules'

describe('platform-modules service (coverage / ADR dual-level)', () => {
  async function db() {
    const env = createMemoryEnv({ ENVIRONMENT: 'test' })
    for (const id of ['org_x', 'org_locked', 'org_flows_seed']) {
      await env.DB.prepare(
        'INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(id, id, id, 1)
        .run()
    }
    return createDb(env.DB as unknown as D1Database, schema)
  }

  it('reads module and role state without initializing missing rows', async () => {
    const d = await db()
    expect((await platformModulesService.listPlatformPublic(d)).demo).toMatchObject({
      available: false,
      configured: true,
      configPath: '/admin/modules',
    })
    expect((await platformModulesService.getOrgModulesEffective(d, 'org_x')).demo).toEqual({
      available: false,
      enabled: false,
      locked: false,
      effective: false,
      configured: true,
      configPath: '/admin/modules',
    })
    expect(await listRolesWithGrants(d, 'org_x')).toEqual([])
    expect(await listPlatformModules(d)).toEqual([])
    expect(await listRolesForOrg(d, 'org_x')).toEqual([])

    await platformModulesService.ensurePlatformModules(d)
    await platformModulesService.setPlatformAvailable(d, 'demo', true)
    await platformModulesService.setOrgModuleEnabled(d, 'org_x', 'demo', true)
    expect(
      await resolveModuleAccess(d, {
        organizationId: 'org_x',
        roleKey: 'owner',
        moduleId: 'demo',
        op: 'read',
      }),
    ).toBe(false)
    expect(await listRolesForOrg(d, 'org_x')).toEqual([])
    await ensureSystemRoles(d, 'org_x')
    expect(
      await resolveModuleAccess(d, {
        organizationId: 'org_x',
        roleKey: 'owner',
        moduleId: 'demo',
        op: 'read',
      }),
    ).toBe(true)
  })

  it('ensure + list platform public state', async () => {
    const d = await db()
    await platformModulesService.ensurePlatformModules(d)
    const list = await platformModulesService.listPlatformPublic(d)
    expect(list.demo).toMatchObject({
      available: false,
      configured: true,
    })
  })

  it('provisions missing catalogue rows without replacing settings or timestamps', async () => {
    const d = await db()
    const configuredDemo = {
      moduleId: 'demo',
      available: true,
      configJson: '{"saved":true}',
      updatedAt: 123,
    }
    await upsertPlatformModule(d, configuredDemo)

    await platformModulesService.ensurePlatformModules(d)

    expect(await getPlatformModule(d, 'demo')).toEqual(configuredDemo)
    expect(await getPlatformModule(d, FLOWS_MODULE_ID)).toEqual({
      moduleId: FLOWS_MODULE_ID,
      available: false,
      configJson: null,
      updatedAt: expect.any(Number),
    })
  })

  it('does not overwrite a setting inserted at the bootstrap conflict point', async () => {
    const d = await db()
    // Inject the competing setting after any preflight read, before the default INSERT.
    await d.run(sql`
      CREATE TRIGGER competing_platform_setting BEFORE INSERT ON platform_modules
      WHEN NEW.module_id = 'demo' AND NEW.available = 0
      BEGIN
        INSERT INTO platform_modules (module_id, available, config_json, updated_at)
        VALUES ('demo', 1, '{"concurrent":true}', 123);
      END
    `)

    await platformModulesService.ensurePlatformModules(d)

    expect(await getPlatformModule(d, 'demo')).toEqual({
      moduleId: 'demo',
      available: true,
      configJson: '{"concurrent":true}',
      updatedAt: 123,
    })
  })

  it('effective = available ∧ org enabled', async () => {
    const d = await db()
    await platformModulesService.ensurePlatformModules(d)
    await platformModulesService.setPlatformAvailable(d, 'demo', true)

    await platformModulesService.setOrgModuleEnabled(d, 'org_x', 'demo', false)
    expect(await platformModulesService.isModuleEffective(d, 'org_x', 'demo')).toBe(false)

    await platformModulesService.setOrgModuleEnabled(d, 'org_x', 'demo', true)
    expect(await platformModulesService.isModuleEffective(d, 'org_x', 'demo')).toBe(true)

    const eff = await platformModulesService.getOrgModulesEffective(d, 'org_x')
    expect(eff.demo.effective).toBe(true)
    expect(eff.demo.available).toBe(true)
    expect(eff.demo.enabled).toBe(true)
  })

  it('requires both availability flags to be stored as numeric 1', async () => {
    const d = await db()
    await platformModulesService.setPlatformAvailable(d, 'demo', true)
    await platformModulesService.setOrgModuleEnabled(d, 'org_x', 'demo', true)

    // A BLOB containing "1" is not the SQLite integer 1.
    await d
      .update(platformModules)
      .set({ available: sql`x'31'` })
      .where(eq(platformModules.moduleId, 'demo'))
    expect(await platformModulesService.isModuleEffective(d, 'org_x', 'demo')).toBe(false)

    await platformModulesService.setPlatformAvailable(d, 'demo', true)
    await d
      .update(organizationModules)
      .set({ enabled: sql`x'31'` })
      .where(eq(organizationModules.organizationId, 'org_x'))
    expect(await platformModulesService.isModuleEffective(d, 'org_x', 'demo')).toBe(false)
  })

  it('rejects enable when platform unavailable', async () => {
    const d = await db()
    await platformModulesService.ensurePlatformModules(d)
    await expect(
      platformModulesService.setOrgModuleEnabled(d, 'org_x', 'demo', true),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects enable when locked', async () => {
    const d = await db()
    await platformModulesService.ensurePlatformModules(d)
    await platformModulesService.setPlatformAvailable(d, 'demo', true)
    const { upsertOrgModule } = await import('@kit/auth/repos/platform-modules')
    await upsertOrgModule(d, {
      organizationId: 'org_locked',
      moduleId: 'demo',
      enabled: false,
      locked: true,
      updatedAt: Date.now(),
    })
    await expect(
      platformModulesService.setOrgModuleEnabled(d, 'org_locked', 'demo', true),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('setPlatformAvailable succeeds for demo without remote config', async () => {
    const d = await db()
    await platformModulesService.ensurePlatformModules(d)
    await platformModulesService.setPlatformAvailable(d, 'demo', true)
    const list = await platformModulesService.listPlatformPublic(d)
    expect(list.demo.available).toBe(true)
  })

  it('registers flows in kit module catalogue (ensure + configured V0)', async () => {
    expect(KIT_MODULE_IDS).toContain(FLOWS_MODULE_ID)
    expect(isKitModuleId('flows')).toBe(true)
    expect(isModuleConfigured(FLOWS_MODULE_ID, null)).toBe(true)

    const d = await db()
    await platformModulesService.ensurePlatformModules(d)
    const list = await platformModulesService.listPlatformPublic(d)
    expect(list.flows).toMatchObject({
      available: false,
      configured: true,
    })

    await platformModulesService.setPlatformAvailable(d, FLOWS_MODULE_ID, true)
    const after = await platformModulesService.listPlatformPublic(d)
    expect(after.flows.available).toBe(true)
  })

  it('ensureSystemRoles seeds flows write for owner/admin only (not member)', async () => {
    const d = await db()
    await ensureSystemRoles(d, 'org_flows_seed')
    const roles = await listRolesWithGrants(d, 'org_flows_seed')
    const byKey = Object.fromEntries(roles.map((r) => [r.key, r]))
    const access = (key: string) =>
      byKey[key]?.grants.find((g) => g.moduleId === FLOWS_MODULE_ID)?.access
    expect(access('owner')).toBe('write')
    expect(access('admin')).toBe('write')
    expect(access('member')).toBe('disabled')
    expect(access('reader')).toBe('disabled')
  })
})
