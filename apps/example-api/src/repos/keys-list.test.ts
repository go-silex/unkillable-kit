import * as keysRepo from '@kit/auth/repos/keys'
import { createDb } from '@kit/db'
import { describe, expect, it } from 'vitest'
import { schema } from '../db/schema'
import { createMemoryEnv } from '../test/memory-env'

/**
 * Explicit list paths (no dual blank semantics):
 * - listApiKeysForSubject → all keys for subject (session)
 * - listApiKeysForOrg → D11 scoped; blank org is a programming error (throw)
 * HTTP missing-org → [] is owned by GET /api/keys route short-circuit only.
 */
describe('listApiKeysForSubject / listApiKeysForOrg', () => {
  async function seedStaffKeys() {
    const env = createMemoryEnv({
      BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
      BETTER_AUTH_URL: 'http://localhost:8787',
      ENVIRONMENT: 'test',
    })
    const db = createDb(env.DB as unknown as D1Database, schema)
    const now = Date.now()
    await keysRepo.insertApiKey(db, {
      id: 'key_1',
      keyHash: 'hash_1',
      keyPrefix: 'sk_aaaa',
      subject: 'user_staff',
      organizationId: 'org_acme',
      createdAt: now,
    })
    await keysRepo.insertApiKey(db, {
      id: 'key_2',
      keyHash: 'hash_2',
      keyPrefix: 'sk_bbbb',
      subject: 'user_staff',
      organizationId: 'org_beta',
      createdAt: now,
    })
    return db
  }

  it('listApiKeysForSubject returns all keys for subject', async () => {
    const db = await seedStaffKeys()
    const all = await keysRepo.listApiKeysForSubject(db, 'user_staff')
    expect(all.map((k) => k.id).sort()).toEqual(['key_1', 'key_2'])
  })

  it('listApiKeysForOrg scopes to a real organizationId', async () => {
    const db = await seedStaffKeys()
    const scoped = await keysRepo.listApiKeysForOrg(db, 'user_staff', 'org_acme')
    expect(scoped.map((k) => k.id)).toEqual(['key_1'])
  })

  it('listApiKeysForOrg with empty string throws (not silent [])', async () => {
    const db = await seedStaffKeys()
    await expect(keysRepo.listApiKeysForOrg(db, 'user_staff', '')).rejects.toThrow(
      /organizationId must be non-empty/,
    )
  })

  it('listApiKeysForOrg with whitespace throws (not silent [])', async () => {
    const db = await seedStaffKeys()
    await expect(keysRepo.listApiKeysForOrg(db, 'user_staff', '   ')).rejects.toThrow(
      /organizationId must be non-empty/,
    )
  })
})
