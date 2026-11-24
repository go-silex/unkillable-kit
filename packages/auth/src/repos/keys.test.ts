import { describe, expect, it } from 'vitest'
import { insertApiKey, listApiKeysForOrg } from './keys'
import { createMemoryD1 } from './memory-d1'
import {
  getKitModule,
  insertKitModule,
  listKitModules,
  setKitModuleConfig,
  setKitModuleEnabled,
} from './modules'
import { getPlatformRole, getPlatformRolesForUsers, setPlatformRole } from './platform-roles'

const KEY_PREFIX = 'sk_aaaaaaaaaa'

describe('auth keys/modules/roles repos', () => {
  it('lists inserted key metadata only for the owning subject and organization', async () => {
    const db = createMemoryD1()
    await insertApiKey(db, {
      id: 'k1',
      keyHash: 'h',
      keyPrefix: KEY_PREFIX,
      subject: 'user-1',
      organizationId: 'org-a',
      scopes: 'read,write',
      createdAt: 1,
    })
    expect(await listApiKeysForOrg(db, 'user-1', 'org-a')).toEqual([
      {
        id: 'k1',
        keyPrefix: KEY_PREFIX,
        subject: 'user-1',
        organizationId: 'org-a',
        scopes: 'read,write',
        name: null,
        createdAt: 1,
        expiresAt: null,
        revokedAt: null,
      },
    ])
    expect(await listApiKeysForOrg(db, 'user-1', 'org-b')).toEqual([])
    expect(await listApiKeysForOrg(db, 'user-2', 'org-a')).toEqual([])
  })

  it('executes module lookups', async () => {
    const db = createMemoryD1()

    expect(await listKitModules(db)).toEqual([])
    expect(await getKitModule(db, 'flows')).toBeUndefined()
    await insertKitModule(db, 'flows', true, null, 1)
    expect(await getKitModule(db, 'flows')).toMatchObject({
      id: 'flows',
      enabled: true,
      configJson: null,
      updatedAt: 1,
    })
    expect(await listKitModules(db)).toEqual([
      expect.objectContaining({ id: 'flows', enabled: true, configJson: null, updatedAt: 1 }),
    ])
    await setKitModuleEnabled(db, 'flows', false, 2)
    expect(await getKitModule(db, 'flows')).toMatchObject({ enabled: false, updatedAt: 2 })
    await setKitModuleConfig(db, 'flows', '{}', 3)
    expect(await getKitModule(db, 'flows')).toMatchObject({ configJson: '{}', updatedAt: 3 })
  })

  it('reads and writes platform roles', async () => {
    const db = createMemoryD1()
    expect(await getPlatformRole(db, 'user-1')).toBeNull()
    expect(await getPlatformRolesForUsers(db, [])).toEqual(new Map())
    expect(await getPlatformRolesForUsers(db, ['user-1'])).toEqual(new Map())
    await setPlatformRole(db, 'user-1', 'staff', 10)
    expect(await getPlatformRole(db, 'user-1')).toBe('staff')
    expect(await getPlatformRolesForUsers(db, ['user-1'])).toEqual(new Map([['user-1', 'staff']]))
    expect(await getPlatformRole(db, 'user-2')).toBeNull()
    expect(await getPlatformRolesForUsers(db, ['user-2'])).toEqual(new Map())
  })
})
