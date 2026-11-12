import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'
import { flowsDrizzleSchema } from '../drizzle-schema'
import { createMemoryDb } from '../run/test/memory-db'
import { persistReceiptJson } from './events'
import {
  claimRun,
  insertFlowRunEvent,
  listFlowRunEvents,
  markQueuedRunCreateFailed,
  persistRunBundle,
} from './index'
import { closeOwnedRun } from './run-mutations'

async function seedQueued(db: ReturnType<typeof createMemoryDb>, runId: string, orgId: string) {
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO flow_plans (id, org_id, plan_key, version, enabled, plan_json, plan_digest, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, '{}', 'digest', ?, ?)`,
    )
    .bind(`plan_${runId}`, orgId, runId, now, now)
    .run()
  await db
    .prepare(
      `INSERT INTO flow_runs (
        id, org_id, plan_id, plan_key, status, actor_id, snapshot_json, plan_digest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 'actor', '{}', 'digest', ?, ?)`,
    )
    .bind(runId, orgId, `plan_${runId}`, runId, now, now)
    .run()
}

function kitDb(db: ReturnType<typeof createMemoryDb>) {
  return drizzle(db, { schema: flowsDrizzleSchema })
}

describe('flow_run_events (Roxabi/roxabi-boilerplate-cf#230)', () => {
  it('applies 0017 additively — flow_run_events exists and flow_runs is unchanged', async () => {
    const db = createMemoryDb()
    const cols = await db
      .prepare(`SELECT name FROM pragma_table_info('flow_run_events')`)
      .all<{ name: string }>()
    const colNames = (cols.results ?? []).map((c) => c.name)
    expect(colNames).toEqual(
      expect.arrayContaining([
        'id',
        'org_id',
        'run_id',
        'seq',
        'kind',
        'status_from',
        'status_to',
        'task_id',
        'outcome',
        'error_code',
        'created_at',
      ]),
    )
    expect(colNames).not.toContain('output')
    const runCols = await db
      .prepare(`SELECT name FROM pragma_table_info('flow_runs')`)
      .all<{ name: string }>()
    expect((runCols.results ?? []).map((c) => c.name)).toContain('receipt_json')
  })

  it('rejects an insert without org_id at the SQL layer', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'run_no_org', 'org_a')
    await expect(
      db
        .prepare(
          `INSERT INTO flow_run_events (id, run_id, seq, kind, created_at)
           VALUES ('evt_x', 'run_no_org', 1, 'status', 1)`,
        )
        .run(),
    ).rejects.toThrow()
  })

  it('claim writes one status event queued→running with the run org_id', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'run_claim', 'org_a')
    expect(
      await claimRun(kitDb(db), { runId: 'run_claim', orgId: 'org_a', instanceId: 'wf_1' }),
    ).toBe(1)
    const events = await listFlowRunEvents(kitDb(db), 'org_a', 'run_claim')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      orgId: 'org_a',
      runId: 'run_claim',
      seq: 1,
      kind: 'status',
      statusFrom: 'queued',
      statusTo: 'running',
    })
  })

  it('persist emits receipt events with task_id+outcome and no output column', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'run_recv', 'org_a')
    await claimRun(kitDb(db), { runId: 'run_recv', orgId: 'org_a', instanceId: 'wf_1' })
    const receipt = JSON.stringify({
      receiptVersion: 1,
      tokensUsed: 0,
      tasks: { echo: { taskId: 'echo', outcome: 'ok' } },
    })
    expect(
      await persistRunBundle(kitDb(db), {
        runId: 'run_recv',
        orgId: 'org_a',
        status: 'succeeded',
        receiptJson: receipt,
      }),
    ).toBe(1)
    const events = await listFlowRunEvents(kitDb(db), 'org_a', 'run_recv')
    const receiptEvt = events.find((e) => e.kind === 'receipt')
    expect(receiptEvt).toMatchObject({ taskId: 'echo', outcome: 'ok', orgId: 'org_a' })
    expect(receiptEvt).not.toHaveProperty('output')
    const statusEvt = events.find((e) => e.kind === 'status' && e.statusTo === 'succeeded')
    expect(statusEvt).toMatchObject({ statusFrom: 'running', statusTo: 'succeeded' })
  })

  it('listFlowRunEvents for org B on org A run is empty', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'run_iso', 'org_a')
    await claimRun(kitDb(db), { runId: 'run_iso', orgId: 'org_a', instanceId: 'wf_1' })
    expect(await listFlowRunEvents(kitDb(db), 'org_b', 'run_iso')).toEqual([])
  })

  it('markQueuedRunCreateFailed appends queued→failed', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'run_wf', 'org_a')
    expect(await markQueuedRunCreateFailed(kitDb(db), { id: 'run_wf', orgId: 'org_a' })).toBe(true)
    const events = await listFlowRunEvents(kitDb(db), 'org_a', 'run_wf')
    expect(events[0]).toMatchObject({
      kind: 'status',
      statusFrom: 'queued',
      statusTo: 'failed',
      errorCode: 'WORKFLOW_CREATE_FAILED',
    })
  })

  it('repo surface has insert+list only — no update/delete helpers', async () => {
    const mod = await import('./index')
    const names = Object.keys(mod).filter((k) => /flowRunEvent|FlowRunEvent/i.test(k))
    expect(names.sort()).toEqual(['insertFlowRunEvent', 'listFlowRunEvents'].sort())
    expect(mod).not.toHaveProperty('updateFlowRunEvent')
    expect(mod).not.toHaveProperty('deleteFlowRunEvent')
  })

  it('insertFlowRunEvent fails closed when the insert cannot land', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'run_gap', 'org_a')
    await db.prepare(`DROP TABLE flow_run_events`).run()
    await expect(
      insertFlowRunEvent(kitDb(db), {
        orgId: 'org_a',
        runId: 'run_gap',
        kind: 'status',
        statusFrom: 'queued',
        statusTo: 'running',
      }),
    ).rejects.toThrow()
  })

  it('rolls back a claim if its status event aborts, then retries exactly once with ownership fences', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'atomic_claim', 'org_a')
    const before = await db
      .prepare(`SELECT status, workflow_instance_id, receipt_json, error_code, updated_at
      FROM flow_runs WHERE id = ?`)
      .bind('atomic_claim')
      .first()
    await db
      .prepare(`CREATE TRIGGER reject_event BEFORE INSERT ON flow_run_events
      WHEN EXISTS (SELECT 1 FROM flow_runs WHERE id = NEW.run_id AND org_id = NEW.org_id
        AND status = 'running' AND workflow_instance_id = 'wf_1' AND updated_at = 123)
      BEGIN SELECT RAISE(ABORT, 'event rejected'); END`)
      .run()
    const input = { runId: 'atomic_claim', orgId: 'org_a', instanceId: 'wf_1', now: 123 }
    await expect(claimRun(kitDb(db), input)).rejects.toThrow()
    expect(
      await db
        .prepare(`SELECT status, workflow_instance_id, receipt_json, error_code, updated_at
      FROM flow_runs WHERE id = ?`)
        .bind(input.runId)
        .first(),
    ).toEqual(before)
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.runId)).toEqual([])
    await db.prepare(`DROP TRIGGER reject_event`).run()
    expect(await claimRun(kitDb(db), input)).toBe(1)
    expect(await claimRun(kitDb(db), input)).toBe(1)
    expect(await claimRun(kitDb(db), { ...input, instanceId: 'wf_2' })).toBe(0)
    expect(await claimRun(kitDb(db), { ...input, orgId: 'org_b' })).toBe(0)
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.runId)).toMatchObject([
      { kind: 'status', statusFrom: 'queued', statusTo: 'running' },
    ])
  })

  it('rolls back the bundle and earlier event inserts when a later receipt event aborts', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'atomic_bundle', 'org_a')
    await claimRun(kitDb(db), { runId: 'atomic_bundle', orgId: 'org_a', instanceId: 'wf_1' })
    const before = await db
      .prepare(`SELECT status, receipt_json, error_code, updated_at FROM flow_runs WHERE id = ?`)
      .bind('atomic_bundle')
      .first()
    const previousEvents = await listFlowRunEvents(kitDb(db), 'org_a', 'atomic_bundle')
    await db
      .prepare(`CREATE TRIGGER reject_second BEFORE INSERT ON flow_run_events
      WHEN NEW.task_id = 'second' AND EXISTS (SELECT 1 FROM flow_runs
        WHERE id = NEW.run_id AND org_id = NEW.org_id AND status = 'succeeded'
        AND updated_at = 456 AND json_extract(receipt_json, '$.tasks.second.outcome') = 'ok')
      BEGIN SELECT RAISE(ABORT, 'second rejected'); END`)
      .run()
    const input = {
      runId: 'atomic_bundle',
      orgId: 'org_a',
      status: 'succeeded',
      now: 456,
      receiptJson: JSON.stringify({
        receiptVersion: 1,
        tokensUsed: 0,
        tasks: {
          first: { taskId: 'first', outcome: 'ok' },
          second: { taskId: 'second', outcome: 'ok' },
        },
      }),
    }
    await expect(persistRunBundle(kitDb(db), input)).rejects.toThrow()
    expect(
      await db
        .prepare(`SELECT status, receipt_json, error_code, updated_at FROM flow_runs WHERE id = ?`)
        .bind(input.runId)
        .first(),
    ).toEqual(before)
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.runId)).toEqual(previousEvents)
    await db.prepare(`DROP TRIGGER reject_second`).run()
    expect(await persistRunBundle(kitDb(db), { ...input, orgId: 'org_b' })).toBe(0)
    expect(await persistRunBundle(kitDb(db), input)).toBe(1)
    expect(await persistRunBundle(kitDb(db), input)).toBe(0)
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.runId)).toMatchObject([
      { kind: 'status', statusTo: 'running' },
      { kind: 'status', statusFrom: 'running', statusTo: 'succeeded' },
      { kind: 'receipt', taskId: 'first', outcome: 'ok' },
      { kind: 'receipt', taskId: 'second', outcome: 'ok' },
    ])
  })

  it('rejects a stale bundle after a competing receipt commits before its batch', async () => {
    const db = createMemoryDb()
    const runId = 'snapshot_race'
    const orgId = 'org_a'
    await seedQueued(db, runId, orgId)
    expect(await claimRun(kitDb(db), { runId, orgId, instanceId: 'wf_1' })).toBe(1)
    const winner = JSON.stringify({ tasks: { task: { taskId: 'task', outcome: 'started' } } })
    const loser = JSON.stringify({ tasks: { task: { taskId: 'task', outcome: 'ok' } } })
    const snapshot = async () => ({
      row: await db
        .prepare(`SELECT status, workflow_instance_id, snapshot_json, receipt_json,
        error_code, updated_at FROM flow_runs WHERE id = ? AND org_id = ?`)
        .bind(runId, orgId)
        .first(),
      events: await listFlowRunEvents(kitDb(db), orgId, runId),
    })
    let winningSnapshot = ''
    const interleaved = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'batch') return Reflect.get(target, property, receiver)
        return async (statements: D1PreparedStatement[]) => {
          expect(
            await persistRunBundle(kitDb(db), {
              runId,
              orgId,
              status: 'running',
              receiptJson: winner,
              now: 101,
            }),
          ).toBe(1)
          const committed = await snapshot()
          expect(committed.row).toMatchObject({
            status: 'running',
            workflow_instance_id: 'wf_1',
            snapshot_json: '{}',
            receipt_json: winner,
            error_code: null,
            updated_at: 101,
          })
          expect(committed.events).toMatchObject([
            { kind: 'status', statusTo: 'running' },
            { kind: 'receipt', taskId: 'task', outcome: 'started' },
          ])
          winningSnapshot = JSON.stringify(committed)
          return target.batch(statements)
        }
      },
    })
    expect(
      await persistRunBundle(kitDb(interleaved), {
        runId,
        orgId,
        status: 'running',
        receiptJson: loser,
        now: 102,
      }),
    ).toBe(0)
    expect(winningSnapshot).not.toBe('')
    expect(JSON.stringify(await snapshot())).toBe(winningSnapshot)
  })

  it('refuses closure at the SQL owner fence when the current owner differs', async () => {
    const db = createMemoryDb()
    const runId = 'close_other_owner'
    const orgId = 'org_a'
    await seedQueued(db, runId, orgId)
    await claimRun(kitDb(db), { runId, orgId, instanceId: 'wf_owner' })
    const before = await db.prepare('SELECT * FROM flow_runs WHERE id = ?').bind(runId).first()
    const events = await listFlowRunEvents(kitDb(db), orgId, runId)
    expect(
      await closeOwnedRun(kitDb(db), {
        runId,
        orgId,
        instanceId: 'wf_other',
        beforeReceiptJson: null,
        receiptJson: null,
        errorCode: null,
      }),
    ).toBe(0)
    expect(await db.prepare('SELECT * FROM flow_runs WHERE id = ?').bind(runId).first()).toEqual(
      before,
    )
    expect(await listFlowRunEvents(kitDb(db), orgId, runId)).toEqual(events)
  })

  it('rolls back a terminal receipt scrub and retries without duplicate receipt events', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'atomic_scrub', 'org_a')
    await db
      .prepare(`UPDATE flow_runs SET status = 'failed', error_code = 'CANCELLED',
      receipt_json = ? WHERE id = ?`)
      .bind(
        JSON.stringify({
          tasks: { first: { outcome: 'started' }, second: { outcome: 'started' } },
        }),
        'atomic_scrub',
      )
      .run()
    const before = await db
      .prepare(`SELECT status, receipt_json, error_code, updated_at FROM flow_runs WHERE id = ?`)
      .bind('atomic_scrub')
      .first()
    await db
      .prepare(`CREATE TRIGGER reject_second BEFORE INSERT ON flow_run_events
      WHEN NEW.task_id = 'second' AND EXISTS (SELECT 1 FROM flow_runs
        WHERE id = NEW.run_id AND org_id = NEW.org_id AND status = 'failed'
        AND updated_at = 789 AND json_extract(receipt_json, '$.tasks.second.outcome') = 'fail')
      BEGIN SELECT RAISE(ABORT, 'second rejected'); END`)
      .run()
    const input = {
      runId: 'atomic_scrub',
      orgId: 'org_a',
      now: 789,
      receiptJson: JSON.stringify({
        tasks: {
          first: { outcome: 'fail', errorCode: 'RECEIPT_LOST' },
          second: { outcome: 'fail', errorCode: 'RECEIPT_LOST' },
        },
      }),
    }
    await expect(persistReceiptJson(kitDb(db), input)).rejects.toThrow()
    expect(
      await db
        .prepare(`SELECT status, receipt_json, error_code, updated_at FROM flow_runs WHERE id = ?`)
        .bind(input.runId)
        .first(),
    ).toEqual(before)
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.runId)).toEqual([])
    await db.prepare(`DROP TRIGGER reject_second`).run()
    expect(await persistReceiptJson(kitDb(db), { ...input, orgId: 'org_b' })).toBe(0)
    expect(await persistReceiptJson(kitDb(db), input)).toBe(1)
    await persistReceiptJson(kitDb(db), input)
    expect(
      await db
        .prepare(`SELECT status, receipt_json, error_code FROM flow_runs WHERE id = ?`)
        .bind(input.runId)
        .first(),
    ).toMatchObject({ status: 'failed', error_code: 'CANCELLED', receipt_json: input.receiptJson })
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.runId)).toMatchObject([
      { kind: 'receipt', taskId: 'first', outcome: 'fail', errorCode: 'RECEIPT_LOST' },
      { kind: 'receipt', taskId: 'second', outcome: 'fail', errorCode: 'RECEIPT_LOST' },
    ])
  })

  it('rolls back create failure when its event aborts and keeps queued and tenant fences', async () => {
    const db = createMemoryDb()
    await seedQueued(db, 'atomic_create', 'org_a')
    await db
      .prepare(`CREATE TRIGGER reject_event BEFORE INSERT ON flow_run_events
      WHEN EXISTS (SELECT 1 FROM flow_runs WHERE id = NEW.run_id AND org_id = NEW.org_id
        AND status = 'failed' AND error_code = 'WORKFLOW_CREATE_FAILED')
      BEGIN SELECT RAISE(ABORT, 'event rejected'); END`)
      .run()
    const input = { id: 'atomic_create', orgId: 'org_a' }
    await expect(markQueuedRunCreateFailed(kitDb(db), input)).rejects.toThrow()
    expect(
      await db
        .prepare(`SELECT status, error_code FROM flow_runs WHERE id = ?`)
        .bind(input.id)
        .first(),
    ).toMatchObject({ status: 'queued', error_code: null })
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.id)).toEqual([])
    await db.prepare(`DROP TRIGGER reject_event`).run()
    expect(await markQueuedRunCreateFailed(kitDb(db), { ...input, orgId: 'org_b' })).toBe(false)
    expect(await markQueuedRunCreateFailed(kitDb(db), input)).toBe(true)
    expect(await markQueuedRunCreateFailed(kitDb(db), input)).toBe(false)
    expect(await listFlowRunEvents(kitDb(db), 'org_a', input.id)).toMatchObject([
      {
        kind: 'status',
        statusFrom: 'queued',
        statusTo: 'failed',
        errorCode: 'WORKFLOW_CREATE_FAILED',
      },
    ])
  })
})
