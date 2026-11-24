import { listPlatformModules } from '@kit/auth/repos/platform-modules'
import { createDb } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { schema } from '../db/schema'
import { createMemoryEnv } from '../test/memory-env'
import { getModulesState, isModuleEnabled, setModuleEnabled } from './modules'
import { ensurePlatformModules } from './platform-modules'

describe('kit modules service', () => {
  it('does not initialize a missing catalogue when reading legacy state', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB, schema)
    expect((await getModulesState(db)).demo).toEqual({
      enabled: false,
      configured: true,
      configPath: '/admin/modules',
    })
    expect(await listPlatformModules(db)).toEqual([])
  })

  it('creates demo module disabled but configured (no remote integration)', async () => {
    const env = createMemoryEnv()
    const db = createDb(env.DB, schema)
    await ensurePlatformModules(db)
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
    await setModuleEnabled(db, 'demo', true)
    expect(await isModuleEnabled(db, 'demo')).toBe(true)
  })
})
