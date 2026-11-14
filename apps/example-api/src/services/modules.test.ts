import { listPlatformModules } from '@kit/auth/repos/platform-modules'
import { createDb } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { schema } from '../db/schema'
import { createMemoryEnv } from '../test/memory-env'
import { ensureKitModules, getModulesState, isModuleEnabled, setModuleEnabled } from './modules'

describe('kit modules service', () => {
  it('does not initialize the catalogue for read-only state', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB, schema)
    expect(await listPlatformModules(db)).toEqual([])
    await getModulesState(db, { readOnly: true })
    expect(await listPlatformModules(db)).toEqual([])
    await getModulesState(db)
    expect((await listPlatformModules(db)).length).toBeGreaterThan(0)
  })

  it('creates demo module disabled but configured (no remote integration)', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB, schema)
    await ensureKitModules(db)
    const state = await getModulesState(db)
    expect(state.demo).toEqual({
      enabled: false,
      configured: true,
      configPath: '/admin/modules',
    })
  })

  it('allows enable without external integration for demo module', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB, schema)
    await ensureKitModules(db)
    await setModuleEnabled(db, 'demo', true)
    expect(await isModuleEnabled(db, 'demo')).toBe(true)
  })
})
