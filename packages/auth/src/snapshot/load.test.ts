import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apiKeyPrefix, generateApiKey, hashApiKey } from '../keys'
import { type AuthorizationFact, defineAuthorizationFact } from './facts'
import { loadRequestSnapshot } from './load'
import { DELEGATION_ROWS, fixture } from './load.fixture'

const userFlags = {
  name: 'product_flags',
  columns: ['user_id', 'organization_id', 'flag'],
} as const
const grantTable = {
  name: 'organization_role_module_grants',
  columns: ['role_id', 'module_id', 'access'],
} as const

describe('authoritative request snapshot', () => {
  it('reads core and Product data from the same primary binding batch, without decoding', async () => {
    const { db, cookie, token } = fixture()
    const decode = vi.fn((rows: readonly Record<string, unknown>[]) => rows[0]?.flag === 'eligible')
    const fact = defineAuthorizationFact({
      table: userFlags,
      scope: { kind: 'user', userId: 'user_id' },
      select: ['flag'],
      where: { organization_id: 'chosen' },
      decode,
    })
    const snapshot = await loadRequestSnapshot({
      db,
      cookie,
      organizationId: 'chosen',
      facts: [fact],
    })
    expect(snapshot.identity).toEqual({
      method: 'session',
      subject: 'actor',
      sessionId: 'session-id',
      email: 'actor@example.test',
    })
    expect(snapshot.organization).toEqual({
      status: 'active',
      membershipRole: 'staff_like',
      platformRole: null,
    })
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(db.withSession).not.toHaveBeenCalled()
    expect(db.batch.mock.calls[0]?.[0]).toHaveLength(3)
    expect(decode).not.toHaveBeenCalled()
    const rows = snapshot.rows(fact)
    expect(rows).toEqual([{ flag: 'eligible' }])
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(rows[0])).toBe(true)
    expect(fact.decode(rows)).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(token)
  })

  it('requires live key ownership and fixes Organization scope to the independent selector', async () => {
    const { db, sqlite, cookie } = fixture()
    const key = generateApiKey()
    const hash = await hashApiKey(key)
    sqlite
      .prepare('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(apiKeyPrefix(key), hash, 'actor', 'chosen', 'read', null, null)
    const fact = defineAuthorizationFact({
      table: grantTable,
      scope: { kind: 'organization-role', roleId: 'role_id' },
      select: ['access'],
      where: { module_id: 'calendar' },
      decode: () => null,
    })
    const keyInput = { db, cookie, authorization: `Bearer ${key}`, facts: [fact] }
    const selected = await loadRequestSnapshot({ ...keyInput, organizationId: 'chosen' })
    expect(selected.identity).toEqual({
      method: 'api_key',
      subject: 'actor',
      organizationId: 'chosen',
      scopes: ['read'],
    })
    expect(selected.rows(fact)).toEqual([{ access: 'write' }])
    expect(JSON.stringify(selected)).not.toContain(hash)
    expect(JSON.stringify(selected)).not.toContain(key)
    const wrongOrg = await loadRequestSnapshot({ ...keyInput, organizationId: 'other' })
    expect(wrongOrg.identity?.method).toBe('api_key')
    expect(wrongOrg.organization).toBeNull()
    expect(wrongOrg.rows(fact)).toEqual([])
    const wrongKey = `${key}x`
    expect(
      (await loadRequestSnapshot({ ...keyInput, authorization: `Bearer ${wrongKey}` })).identity,
    ).toBeNull()
    sqlite.exec("DELETE FROM member WHERE organization_id = 'chosen' AND user_id = 'actor'")
    expect((await loadRequestSnapshot(keyInput)).identity).toBeNull()
  })

  it('reports unreadable key expiry only after verifying the key hash', async () => {
    const { db, sqlite } = fixture()
    const key = generateApiKey()
    const prefix = apiKeyPrefix(key)
    sqlite
      .prepare('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(prefix, await hashApiKey(key), 'actor', 'chosen', 'read', null, null)
    const input = { db, authorization: `Bearer ${key}` }
    expect((await loadRequestSnapshot(input)).identity?.method).toBe('api_key')
    const setExpiry = sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE key_prefix = ?')
    setExpiry.run('unreadable', prefix)
    await expect(loadRequestSnapshot(input)).rejects.toMatchObject({
      status: 503,
      message: 'Authorization unavailable',
    })
    expect(
      (await loadRequestSnapshot({ ...input, authorization: `Bearer ${key}x` })).identity,
    ).toBeNull()
    setExpiry.run(Date.now(), prefix)
    expect((await loadRequestSnapshot(input)).identity).toBeNull()
  })

  it('correlates all hosted grant keys and does not use a prior grant for account-only requests', async () => {
    const { db, sqlite } = fixture()
    const fact = defineAuthorizationFact({
      table: { name: 'product_grants', columns: ['user_id', 'grant_id', 'client_id', 'denied'] },
      scope: {
        kind: 'hosted-grant',
        userId: 'user_id',
        grantId: 'grant_id',
        clientId: 'client_id',
      },
      select: ['denied'],
      maxRows: 1,
      decode: () => null,
    })
    const hosted = { userId: 'actor', grantId: 'grant', clientId: 'client' }
    const snapshot = await loadRequestSnapshot({
      db,
      hosted,
      organizationId: 'chosen',
      facts: [fact],
    })
    expect(snapshot.identity).toEqual({ method: 'mcp', subject: 'actor' })
    expect(snapshot.organization?.membershipRole).toBe('staff_like')
    expect(snapshot.rows(fact)).toEqual([{ denied: 1 }])
    expect(
      (await loadRequestSnapshot({ db, hosted: { userId: 'actor' }, facts: [fact] })).rows(fact),
    ).toEqual([])
    expect(
      (await loadRequestSnapshot({ db, hosted: { userId: 'actor', grantId: 'grant' } })).identity,
    ).toBeNull()
    expect(db.batch).toHaveBeenCalledTimes(2)
    sqlite.exec("UPDATE user SET disabled = 1 WHERE id = 'actor'")
    expect((await loadRequestSnapshot({ db, hosted })).identity).toBeNull()
  })

  it('keeps the verified actor and live represented authority separate', async () => {
    const { db, sqlite, cookie } = fixture()
    sqlite.exec(DELEGATION_ROWS)
    const fact = defineAuthorizationFact({
      table: grantTable,
      scope: { kind: 'delegated-role', roleId: 'role_id' },
      select: ['access'],
      where: { module_id: 'calendar' },
      decode: () => null,
    })
    const input = { db, cookie, delegation: true, facts: [fact] }
    const request = await loadRequestSnapshot({ ...input, organizationId: 'chosen' })
    expect(request.delegation).toMatchObject({
      actor: { subject: 'actor', sessionId: 'session-id' },
      organization: { status: 'active', membershipRole: 'reader', platformRole: null },
      actorPlatformRole: 'super_admin',
      targetProfile: { email: 'target@example.test' },
      eligible: true,
    })
    const bearer = await loadRequestSnapshot({
      ...input,
      authorization: 'Bearer unsupported',
      organizationId: 'chosen',
    })
    expect(bearer.identity).toBeNull()
    expect(bearer.delegation?.row?.id).toBe('delegation')
    expect(bearer.rows(fact)).toEqual([])
    expect(request.rows(fact)).toEqual([{ access: 'read' }])
    expect((await loadRequestSnapshot({ ...input, organizationId: 'other' })).rows(fact)).toEqual(
      [],
    )
    sqlite.exec("UPDATE impersonation_role_permissions SET read = 0 WHERE role = 'super_admin'")
    const restricted = await loadRequestSnapshot({ ...input, organizationId: 'chosen' })
    expect(restricted.delegation).toMatchObject({
      row: { id: 'delegation' },
      eligible: false,
      targetProfile: null,
    })
    expect(restricted.rows(fact)).toEqual([])
    sqlite.exec('DELETE FROM impersonation_sessions')
    const unattached = await loadRequestSnapshot({ ...input })
    expect(unattached.delegation).toMatchObject({
      row: null,
      permission: { read: false, write: false },
    })
    sqlite.exec("UPDATE impersonation_role_permissions SET read = 1 WHERE role = 'super_admin'")
    expect((await loadRequestSnapshot({ ...input })).delegation?.permission.read).toBe(true)
  })

  it('does not hit D1 for locally unusable credentials and leaves expiry cleanup to Better Auth', async () => {
    const { db, sqlite, cookie } = fixture()
    expect(
      (await loadRequestSnapshot({ db, authorization: 'Bearer unsupported', cookie })).identity,
    ).toBeNull()
    expect(
      (await loadRequestSnapshot({ db, cookie: { ...cookie, header: null } })).identity,
    ).toBeNull()
    expect(db.prepare).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const now = Date.now()
    sqlite.prepare('UPDATE session SET expires_at = ?').run(now)
    expect((await loadRequestSnapshot({ db, cookie })).identity?.method).toBe('session')
    sqlite.prepare('UPDATE session SET expires_at = ?').run(now - 1)
    expect((await loadRequestSnapshot({ db, cookie })).identity).toBeNull()
    expect(sqlite.prepare('SELECT id FROM session').pluck().get()).toBe('session-id')
  })

  it('reports unreadable session expiry without releasing Product facts', async () => {
    const { db, sqlite, cookie } = fixture()
    const decode = vi.fn()
    const fact = defineAuthorizationFact({
      table: userFlags,
      scope: { kind: 'user', userId: 'user_id' },
      select: ['flag'],
      decode,
    })
    const input = { db, cookie, facts: [fact] }
    expect((await loadRequestSnapshot(input)).rows(fact)).toEqual([{ flag: 'eligible' }])
    sqlite.prepare('UPDATE session SET expires_at = ?').run('unreadable')
    await expect(loadRequestSnapshot(input)).rejects.toMatchObject({
      status: 503,
      message: 'Authorization unavailable',
    })
    await expect(
      loadRequestSnapshot({ ...input, authorization: 'Bearer unsupported', delegation: true }),
    ).rejects.toMatchObject({ status: 503, message: 'Authorization unavailable' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('validates each required fact on access without inspecting unrelated results', async () => {
    const { db, cookie, sqlite } = fixture()
    sqlite.exec('CREATE VIEW product_view AS SELECT user_id, flag FROM product_flags')
    const decode = vi.fn()
    const descriptor = {
      table: userFlags,
      scope: { kind: 'user', userId: 'user_id' },
      select: ['flag'],
      decode,
    } as const
    const view = defineAuthorizationFact({
      ...descriptor,
      table: { ...userFlags, name: 'product_view' },
    })
    const available = defineAuthorizationFact({
      ...descriptor,
      where: { organization_id: 'chosen' },
    })
    const snapshot = await loadRequestSnapshot({ db, cookie, facts: [view, available] })
    expect(snapshot.rows(available)).toEqual([{ flag: 'eligible' }])
    expect(() => snapshot.rows(view)).toThrow('Authorization unavailable')
    const forged = { ...view } as AuthorizationFact<unknown>
    await expect(loadRequestSnapshot({ db, cookie, facts: [forged] })).rejects.toMatchObject({
      status: 503,
    })
    sqlite.exec("INSERT INTO product_flags VALUES ('actor', 'other', 'second row')")
    const fact = defineAuthorizationFact({ ...descriptor, maxRows: 1 })
    const overflowing = await loadRequestSnapshot({ db, cookie, facts: [fact, available] })
    expect(overflowing.rows(available)).toEqual([{ flag: 'eligible' }])
    expect(() => overflowing.rows(fact)).toThrow('Authorization unavailable')
    db.batch.mockResolvedValueOnce([{ success: false, results: [{ flag: 'private row' }] }])
    await expect(loadRequestSnapshot({ db, cookie })).rejects.toMatchObject({
      status: 503,
      message: 'Authorization unavailable',
    })
    expect(decode).not.toHaveBeenCalled()
  })
})
