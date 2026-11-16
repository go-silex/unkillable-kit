import { describe, expect, it, vi } from 'vitest'
import { kitNotificationDeliveries, kitNotifications } from '../drizzle-schema'
import { admitNotifications, interpretAdmitResults, planAdmitNotifications } from '../repos'
import { admission, identities } from '../test/admit-fixtures'
import { createMemoryD1 } from '../test/memory-d1'

type Rows = { results: Record<string, unknown>[] }[]

describe('planned notification admission', () => {
  it('validates and plans in order without executing or writing', async () => {
    const { db, d1 } = createMemoryD1()
    const batchSpy = vi.spyOn(d1, 'batch')
    const input = admission({
      users: [
        {
          id: 'n1',
          userId: 'alice',
          deliveries: Array.from({ length: 11 }, (_, i) => ({ id: `u_${i}`, channel: `c${i}` })),
        },
        { id: 'n2', userId: 'bob', deliveries: [] },
      ],
      organizations: [{ id: 'o_1', destinationId: 'dest', channel: 'slack' }],
    })
    const plan = planAdmitNotifications(d1, input, identities(input))
    expect(plan.orgId).toBe('org-a')
    expect(plan.kinds).toEqual(['notification', 'user', 'user', 'notification', 'organization'])
    expect(plan.statements).toHaveLength(5)
    expect(batchSpy).not.toHaveBeenCalled()
    expect(await db.select().from(kitNotifications)).toEqual([])
    expect(await db.select().from(kitNotificationDeliveries)).toEqual([])
    expect(() => planAdmitNotifications(d1, input, [])).toThrow()
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('rolls back preceding business and real inbox writes on a hard collision', async () => {
    const { sqlite, d1, db } = createMemoryD1()
    sqlite.exec('CREATE TABLE business_events (id TEXT PRIMARY KEY)')
    const existing = admission({ users: [{ id: 'collision', userId: 'existing', deliveries: [] }] })
    await admitNotifications(db, existing, [])
    const input = admission({
      users: [
        { id: 'new-notice', userId: 'alice', deliveries: [] },
        { id: 'collision', userId: 'bob', deliveries: [] },
      ],
    })
    const plan = planAdmitNotifications(d1, input, [])
    const business = d1.prepare('INSERT INTO business_events (id) VALUES (?)').bind('event-1')
    await expect(d1.batch([business, ...plan.statements])).rejects.toThrow()
    expect(sqlite.prepare('SELECT id FROM business_events').all()).toEqual([])
    expect((await db.select().from(kitNotifications)).map((row) => row.id)).toEqual(['collision'])
  })

  it('commits business writes on active dedupe without replacing parameters or adding deliveries', async () => {
    const { sqlite, d1, db } = createMemoryD1()
    sqlite.exec('CREATE TABLE business_events (id TEXT PRIMARY KEY)')
    const first = admission({
      users: [{ id: 'n1', userId: 'alice', deliveries: [{ id: 'u_1', channel: 'email' }] }],
    })
    await admitNotifications(db, first, identities(first))
    const duplicate = admission({
      params: { value: 'changed' },
      users: [{ id: 'n2', userId: 'alice', deliveries: [{ id: 'u_2', channel: 'slack' }] }],
    })
    const plan = planAdmitNotifications(d1, duplicate, identities(duplicate, 2))
    const business = d1.prepare('INSERT INTO business_events (id) VALUES (?)').bind('event-1')
    const results = (await d1.batch([business, ...plan.statements])) as Rows
    expect(interpretAdmitResults(plan, results.slice(1))).toEqual({
      createdNotificationIds: [],
      createdDeliveries: [],
    })
    expect(sqlite.prepare('SELECT id FROM business_events').all()).toEqual([{ id: 'event-1' }])
    expect(
      (await db.select().from(kitNotifications)).map((row) => [row.id, row.paramsJson]),
    ).toEqual([['n1', '{"value":"original"}']])
    expect((await db.select().from(kitNotificationDeliveries)).map((row) => row.id)).toEqual([
      'u_1',
    ])
  })

  it('matches the wrapper for mixed, deduplicated and empty admissions', async () => {
    const planned = createMemoryD1()
    const wrapped = createMemoryD1()
    const first = admission({
      users: [{ id: 'n1', userId: 'alice', deliveries: [{ id: 'u_1', channel: 'email' }] }],
      organizations: [{ id: 'o_1', destinationId: 'dest', channel: 'slack' }],
    })
    const duplicate = admission({
      users: [{ id: 'n2', userId: 'alice', deliveries: [{ id: 'u_2', channel: 'sms' }] }],
      organizations: [{ id: 'o_2', destinationId: 'dest', channel: 'slack' }],
    })
    for (const [input, start] of [
      [first, 1],
      [duplicate, 10],
      [admission(), 20],
    ] as const) {
      const owners = identities(input, start)
      const plan = planAdmitNotifications(planned.d1, input, owners)
      const rows = plan.statements.length
        ? ((await planned.d1.batch([...plan.statements])) as Rows)
        : []
      expect(interpretAdmitResults(plan, rows)).toEqual(
        await admitNotifications(wrapped.db, input, owners),
      )
    }
    expect(await planned.db.select().from(kitNotifications)).toEqual(
      await wrapped.db.select().from(kitNotifications),
    )
    expect(await planned.db.select().from(kitNotificationDeliveries)).toEqual(
      await wrapped.db.select().from(kitNotificationDeliveries),
    )
  })

  it('interprets real mixed results and rejects malformed results and row counts', async () => {
    const { d1 } = createMemoryD1()
    const input = admission({
      users: [
        {
          id: 'n1',
          userId: 'alice',
          deliveries: [
            { id: 'u_1', channel: 'email' },
            { id: 'u_2', channel: 'sms' },
          ],
        },
      ],
      organizations: [{ id: 'o_1', destinationId: 'dest', channel: 'slack' }],
    })
    const plan = planAdmitNotifications(d1, input, identities(input))
    const rows = (await d1.batch([...plan.statements])) as Rows
    expect(interpretAdmitResults(plan, rows)).toEqual({
      createdNotificationIds: ['n1'],
      createdDeliveries: [
        { orgId: 'org-a', kind: 'user', id: 'u_1' },
        { orgId: 'org-a', kind: 'user', id: 'u_2' },
        { orgId: 'org-a', kind: 'organization', id: 'o_1' },
      ],
    })
    expect(() => interpretAdmitResults(plan, rows.slice(1))).toThrow()
    expect(() => interpretAdmitResults(plan, [...rows, { results: [] }])).toThrow()
    expect(() => interpretAdmitResults({ ...plan, kinds: plan.kinds.slice(1) }, rows)).toThrow()
    for (const id of ['', 42, null]) {
      const malformed = rows.map((result) => ({ results: [...result.results] }))
      malformed[0]!.results = [{ id }]
      expect(() => interpretAdmitResults(plan, malformed)).toThrow()
    }
    for (const [index, count] of [
      [0, 2],
      [1, 11],
      [2, 2],
    ] as const) {
      const malformed = rows.map((result) => ({ results: [...result.results] }))
      malformed[index]!.results = Array.from({ length: count }, () => ({ id: 'extra' }))
      expect(() => interpretAdmitResults(plan, malformed)).toThrow()
    }
  })
})
