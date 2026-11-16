import { describe, expect, it, vi } from 'vitest'
import { kitNotificationDeliveries, kitNotifications } from '../drizzle-schema'
import { type InboxReadSelection, markRead } from '../repos'
import { createMemoryD1 } from '../test/memory-d1'

const scope = { orgId: 'org', userId: 'user', readableModuleIds: ['allowed'] }
const base = {
  orgId: 'org',
  userId: 'user',
  typeKey: 'event',
  sourceKind: 'item',
  paramsJson: '{"text":"preserve"}',
  createdAt: 10,
}
const all = { sql: 'SELECT id FROM kit_notifications', params: [] }

describe('inbox read selection', () => {
  it('intersects even broad, duplicate and NULL selections with the Kit ceiling and requested ID', async () => {
    const { db, sqlite } = createMemoryD1()
    await db.insert(kitNotifications).values([
      { ...base, id: 'plain', sourceId: 'plain' },
      { ...base, id: 'allowed', sourceId: 'allowed', moduleId: 'allowed', resolvedAt: 11 },
      { ...base, id: 'hidden', sourceId: 'hidden', moduleId: 'hidden' },
      { ...base, id: 'other', sourceId: 'other', userId: 'other' },
      { ...base, id: 'foreign', sourceId: 'foreign', orgId: 'foreign' },
      { ...base, id: 'read', sourceId: 'read', readAt: 12 },
    ])
    expect(
      await markRead(
        db,
        scope,
        { now: 20 },
        { sql: 'SELECT id FROM kit_notifications WHERE 0', params: [] },
      ),
    ).toBe(0)
    expect(await markRead(db, scope, { id: 'hidden', now: 20 }, all)).toBe(0)
    expect(await markRead(db, scope, { id: 'plain', now: 20 }, all)).toBe(1)
    expect(
      await markRead(
        db,
        scope,
        { now: 21 },
        {
          sql: 'SELECT id FROM kit_notifications UNION ALL SELECT id FROM kit_notifications UNION ALL SELECT NULL',
          params: [],
        },
      ),
    ).toBe(1)
    expect(sqlite.prepare('SELECT id, read_at FROM kit_notifications ORDER BY id').all()).toEqual([
      { id: 'allowed', read_at: 21 },
      { id: 'foreign', read_at: null },
      { id: 'hidden', read_at: null },
      { id: 'other', read_at: null },
      { id: 'plain', read_at: 20 },
      { id: 'read', read_at: 12 },
    ])
  })

  it('binds CTE values in order for read-all and read-one without interpreting SQL literals', async () => {
    const { db, sqlite, boundParams } = createMemoryD1()
    const largeScope = {
      ...scope,
      readableModuleIds: [...Array.from({ length: 150 }, (_, i) => `m${i}`), 'allowed'],
    }
    await db.insert(kitNotifications).values([
      { ...base, id: 'one', sourceId: 'one', moduleId: 'allowed' },
      { ...base, id: 'two', sourceId: 'two', moduleId: 'allowed' },
      { ...base, id: 'other', sourceId: 'other', moduleId: 'allowed', userId: 'other' },
    ])
    sqlite.exec('CREATE TABLE app_access (notification_id TEXT, token TEXT, category TEXT)')
    const token = "x' OR 1=1 --"
    const insert = sqlite.prepare('INSERT INTO app_access VALUES (?, ?, ?)')
    insert.run('one', token, 'first')
    insert.run('two', token, 'second')
    insert.run('other', token, 'first')
    const selection = (category: string) => ({
      sql: "WITH access AS (SELECT notification_id FROM app_access WHERE token = ? AND category = ? AND '?' = '?') SELECT notification_id FROM access",
      params: [token, category],
    })
    expect(await markRead(db, largeScope, { now: 31 }, selection('first'))).toBe(1)
    expect(await markRead(db, largeScope, { id: 'two', now: 32 }, selection('second'))).toBe(1)
    expect(sqlite.prepare('SELECT id, read_at FROM kit_notifications ORDER BY id').all()).toEqual([
      { id: 'one', read_at: 31 },
      { id: 'other', read_at: null },
      { id: 'two', read_at: 32 },
    ])
    expect(Math.max(...boundParams)).toBeLessThanOrEqual(100)
  })

  it('evaluates live access inside one UPDATE and preserves other state and deliveries', async () => {
    const { db, sqlite, d1 } = createMemoryD1()
    await db.insert(kitNotifications).values({ ...base, id: 'n', sourceId: 'n', resolvedAt: 11 })
    await db.insert(kitNotificationDeliveries).values({
      id: 'u_delivery',
      orgId: 'org',
      notificationId: 'n',
      channel: 'email',
      status: 'pending',
      createdAt: 1,
      admissionStatus: 'pending',
      admissionDeadlineAt: 86400001,
      workflowId: `nd-v1-${'a'.repeat(64)}`,
    })
    sqlite.exec(
      "CREATE TABLE app_access (notification_id TEXT, active INTEGER); INSERT INTO app_access VALUES ('n', 1)",
    )
    const selection = {
      sql: 'WITH allowed AS (SELECT notification_id FROM app_access WHERE active = ?) SELECT notification_id FROM allowed',
      params: [1],
    }
    const before = sqlite.prepare('SELECT * FROM kit_notifications').all()
    const deliveries = sqlite.prepare('SELECT * FROM kit_notification_deliveries').all()
    sqlite.exec('UPDATE app_access SET active = 0')
    const prepare = vi.spyOn(d1, 'prepare')
    expect(await markRead(db, scope, { now: 40 }, selection)).toBe(0)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls[0]?.[0]).toMatch(/UPDATE[\s\S]+WITH[\s\S]+SELECT/i)
    expect(sqlite.prepare('SELECT * FROM kit_notifications').all()).toEqual(before)
    sqlite.exec('UPDATE app_access SET active = 1')
    expect(await markRead(db, scope, { now: 40 }, selection)).toBe(1)
    expect(await markRead(db, scope, { now: 50 }, selection)).toBe(0)
    expect(sqlite.prepare('SELECT * FROM kit_notifications').all()).toEqual(
      before.map((row) => ({ ...(row as object), read_at: 40 })),
    )
    expect(sqlite.prepare('SELECT * FROM kit_notification_deliveries').all()).toEqual(deliveries)
  })

  it('rejects invalid selection shapes and SQL without changing rows or retrying unrestricted', async () => {
    const { db, sqlite, d1 } = createMemoryD1()
    await db.insert(kitNotifications).values({ ...base, id: 'n', sourceId: 'n' })
    const before = sqlite.prepare('SELECT * FROM kit_notifications').all()
    const prepare = vi.spyOn(d1, 'prepare')
    const invalid: unknown[] = [
      null,
      {},
      { sql: ' ', params: [] },
      { sql: 'SELECT id FROM kit_notifications' },
      { sql: 'SELECT id FROM kit_notifications', params: 'bad' },
      { sql: 'SELECT FROM', params: [] },
      { sql: 'SELECT id FROM missing_table', params: [] },
      { sql: 'SELECT id, user_id FROM kit_notifications', params: [] },
      { sql: 'SELECT id FROM kit_notifications WHERE id = ?', params: [] },
    ]
    for (const value of invalid) {
      prepare.mockClear()
      await expect(markRead(db, scope, { now: 60 }, value as InboxReadSelection)).rejects.toThrow()
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(1)
      expect(sqlite.prepare('SELECT * FROM kit_notifications').all()).toEqual(before)
    }
  })
})
