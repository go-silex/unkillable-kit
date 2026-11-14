import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { disableAccount, enableAccount, isAccountActive } from './account-state'
import { createMemoryD1 } from './memory-d1'

async function setup() {
  const db = createMemoryD1()
  await db.run(
    sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  )
  await db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)`)
  await db.run(
    sql`INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('actor', 'Actor', 'a@example.test', 0, 0), ('target', 'Target', 't@example.test', 0, 0), ('outsider', 'Outsider', 'o@example.test', 0, 0)`,
  )
  await db.run(
    sql`INSERT INTO member (id, organization_id, user_id, created_at) VALUES ('a', 'org', 'actor', 0), ('t', 'org', 'target', 0), ('o', 'other', 'outsider', 0)`,
  )
  await db.run(sql`INSERT INTO session (id, user_id) VALUES ('session', 'target')`)
  return db
}

const context = { actorUserId: 'actor', organizationId: 'org', targetUserId: 'target' }

describe('account state', () => {
  it('reads live state, denies missing users, and revokes sessions across re-enablement', async () => {
    const db = await setup()
    expect(await isAccountActive(db, 'missing')).toBe(false)
    expect(await isAccountActive(db, 'target')).toBe(true)
    expect(await disableAccount(db, context)).toBe(true)
    expect(await isAccountActive(db, 'target')).toBe(false)
    expect(await enableAccount(db, context)).toBe(true)
    expect(await isAccountActive(db, 'target')).toBe(true)
    const rows = await db.all(sql`SELECT id FROM session WHERE user_id = 'target'`)
    expect(rows).toHaveLength(0)
  })

  it('requires both memberships in the specified organization and a live actor', async () => {
    const db = await setup()
    expect(await disableAccount(db, { ...context, organizationId: 'other' })).toBe(false)
    expect(await disableAccount(db, { ...context, targetUserId: 'outsider' })).toBe(false)
    expect(await disableAccount(db, { ...context, actorUserId: 'outsider' })).toBe(false)
    expect(await disableAccount(db, { ...context, targetUserId: 'missing' })).toBe(false)
    expect(await isAccountActive(db, 'target')).toBe(true)
    await db.run(sql`UPDATE user SET disabled = 1 WHERE id = 'actor'`)
    expect(await disableAccount(db, context)).toBe(false)
    expect(await isAccountActive(db, 'target')).toBe(true)
  })

  it('records configured audit atomically and rolls back when audit fails', async () => {
    const db = await setup()
    expect(await disableAccount(db, { ...context, audit: { requestId: 'r' } })).toBe(true)
    const events = await db.all<{
      action: string
      actor_user_id: string
      org_id: string
      target_id: string
    }>(sql`SELECT action, actor_user_id, org_id, target_id FROM audit_events`)
    expect(events).toEqual([
      { action: 'account.disabled', actor_user_id: 'actor', org_id: 'org', target_id: 'target' },
    ])
    expect(await enableAccount(db, { ...context, organizationId: 'other', audit: {} })).toBe(false)
    expect(await db.all(sql`SELECT id FROM audit_events`)).toHaveLength(1)
    await db.run(sql`DROP TABLE audit_events`)
    await expect(enableAccount(db, { ...context, audit: {} })).rejects.toThrow()
    expect(await isAccountActive(db, 'target')).toBe(false)
    expect(await enableAccount(db, context)).toBe(true)
  })
})
