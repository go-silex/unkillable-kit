import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { kitNotificationDeliveries, kitNotifications } from '../drizzle-schema'
import { admitNotifications } from '../repos'
import { admission, identities } from '../test/admit-fixtures'
import { createMemoryD1 } from '../test/memory-d1'

describe('atomic notification admission', () => {
  it('deduplicates concurrent active requests and a reused id cannot add a channel or replace parameters', async () => {
    const { db } = createMemoryD1()
    const first = admission({
      users: [{ id: 'n1', userId: 'alice', deliveries: [{ id: 'u_1', channel: 'email' }] }],
    })
    const second = admission({
      users: [{ id: 'n2', userId: 'alice', deliveries: [{ id: 'u_2', channel: 'slack' }] }],
    })
    const results = await Promise.all([
      admitNotifications(db, first, identities(first)),
      admitNotifications(db, second, identities(second, 2)),
    ])
    expect(results.flatMap((r) => r.createdNotificationIds)).toHaveLength(1)
    const winner = results[0]?.createdNotificationIds.length ? first : second
    const duplicate = admission({
      params: { value: 'changed' },
      users: [
        { id: winner.users[0]!.id, userId: 'alice', deliveries: [{ id: 'u_new', channel: 'sms' }] },
      ],
    })
    expect(await admitNotifications(db, duplicate, identities(duplicate, 9))).toEqual({
      createdNotificationIds: [],
      createdDeliveries: [],
    })
    expect(await db.select().from(kitNotificationDeliveries)).toHaveLength(1)
    expect((await db.select().from(kitNotifications))[0]?.paramsJson).toBe('{"value":"original"}')
  })

  it('rolls back earlier parents and children when a later child collides', async () => {
    const { db } = createMemoryD1()
    const existing = admission({
      users: [
        { id: 'existing', userId: 'other', deliveries: [{ id: 'u_existing', channel: 'email' }] },
      ],
    })
    await admitNotifications(db, existing, identities(existing))
    const batch = admission({
      users: [
        { id: 'n1', userId: 'alice', deliveries: [{ id: 'u_1', channel: 'email' }] },
        { id: 'n2', userId: 'bob', deliveries: [{ id: 'u_existing', channel: 'email' }] },
      ],
    })
    await expect(admitNotifications(db, batch, identities(batch, 10))).rejects.toThrow()
    expect(
      await db.select().from(kitNotifications).where(eq(kitNotifications.id, 'n1')),
    ).toHaveLength(0)
    expect(await db.select().from(kitNotificationDeliveries)).toHaveLength(1)
  })

  it('chunks child inserts under the bind limit without breaking the changes chain', async () => {
    const { db, boundParams } = createMemoryD1()
    const deliveries = Array.from({ length: 35 }, (_, i) => ({ id: `u_${i}`, channel: `c${i}` }))
    const batch = admission({ users: [{ id: 'n1', userId: 'alice', deliveries }] })
    const result = await admitNotifications(db, batch, identities(batch))
    expect(result.createdDeliveries).toHaveLength(35)
    expect(Math.max(...boundParams)).toBeLessThanOrEqual(100)
    const duplicate = admission({
      users: [
        {
          id: 'n2',
          userId: 'alice',
          deliveries: deliveries.map((d) => ({ ...d, id: `${d.id}new` })),
        },
      ],
    })
    expect(
      (await admitNotifications(db, duplicate, identities(duplicate, 100))).createdDeliveries,
    ).toHaveLength(0)
    expect(await db.select().from(kitNotificationDeliveries)).toHaveLength(35)
  })

  it('deduplicates collective delivery independently of inbox fan-out', async () => {
    const { db } = createMemoryD1()
    const first = admission({
      organizations: [{ id: 'o_1', destinationId: 'dest', channel: 'slack' }],
    })
    const second = admission({
      organizations: [{ id: 'o_2', destinationId: 'dest', channel: 'slack' }],
    })
    expect((await admitNotifications(db, first, identities(first))).createdDeliveries).toHaveLength(
      1,
    )
    expect(
      (await admitNotifications(db, second, identities(second, 2))).createdDeliveries,
    ).toHaveLength(0)
    expect(await db.select().from(kitNotifications)).toHaveLength(0)
  })

  it('rolls back the complete batch on a later workflow collision', async () => {
    const { db } = createMemoryD1()
    const first = admission({
      users: [{ id: 'n1', userId: 'alice', deliveries: [{ id: 'u_a', channel: 'email' }] }],
    })
    const second = admission({
      users: [{ id: 'n2', userId: 'bob', deliveries: [{ id: 'u_b', channel: 'email' }] }],
    })
    await admitNotifications(db, first, identities(first))
    await expect(admitNotifications(db, second, identities(second))).rejects.toThrow()
    expect(
      await db.select().from(kitNotifications).where(eq(kitNotifications.id, 'n2')),
    ).toHaveLength(0)
  })

  it('requires an exact, scoped, valid identity for each planned delivery', async () => {
    const { db } = createMemoryD1()
    const batch = admission({
      users: [{ id: 'n1', userId: 'alice', deliveries: [{ id: 'u_1', channel: 'email' }] }],
    })
    const valid = identities(batch)
    for (const invalid of [
      [],
      [valid[0]!, valid[0]!],
      [{ ...valid[0]!, ref: { ...valid[0]!.ref, orgId: 'other' } }],
      [{ ...valid[0]!, admissionDeadlineAt: batch.now }],
      [{ ...valid[0]!, workflowId: 'wrong' }],
    ]) {
      await expect(admitNotifications(db, batch, invalid)).rejects.toThrow()
    }
    expect(await db.select().from(kitNotifications)).toHaveLength(0)
  })
})
