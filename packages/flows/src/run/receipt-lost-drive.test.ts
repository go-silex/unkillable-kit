import { describe, expect, it } from 'vitest'
import { interpretRun } from '../interpret'
import { type DriveStep, driveFlowRun } from './drive'
import { CHAIN_INVOKE_PLAN_YAML, INVOKE_ONLY_PLAN_YAML } from './fixtures'
import { claimRun, loadRun, persistBundle } from './persist'
import { createMemoryDb } from './test/memory-db'
import { SEED_ORG, seedRun, taskReceipts } from './test/seed-run'

const immediate: DriveStep = async (_name, fn) => fn()

/** Cloudflare-like: a named step result is replayed, never re-run. */
function memoStep(cache: Map<string, unknown>): DriveStep {
  return async (name, fn) => {
    if (cache.has(name)) return cache.get(name) as never
    const out = await fn()
    cache.set(name, out)
    return out
  }
}

describe('receipt lost drive', () => {
  it('does not roll up succeeded when started sits beside ok', async () => {
    const view = await seedRun(createMemoryDb(), {
      runId: 'run_view',
      planYaml: CHAIN_INVOKE_PLAN_YAML,
      status: 'running',
    })
    const result = interpretRun(view, {
      receiptVersion: 1,
      tokensUsed: 0,
      tasks: {
        echo_a: { taskId: 'echo_a', outcome: 'ok' },
        echo_b: { taskId: 'echo_b', outcome: 'started' },
      },
    })
    expect(result.rollup).toBe('failed')
    expect(result.readyTaskIds).toEqual([])
  })

  it('closes a started wave as RECEIPT_LOST and never persists started on a failed run', async () => {
    const db = createMemoryDb()
    await seedRun(db, {
      runId: 'run_chain',
      planYaml: CHAIN_INVOKE_PLAN_YAML,
      status: 'queued',
      tasks: { echo_a: { outcome: 'started' } },
    })
    let calls = 0
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          return { output: 'x' }
        },
        payload: { runId: 'run_chain', orgId: SEED_ORG },
        instanceId: 'wfinst_lost',
      }),
    ).rejects.toMatchObject({ name: 'DriveNonRetryableError', message: 'RECEIPT_LOST' })
    expect(calls).toBe(0)
    const row = await taskReceipts(db, 'run_chain')
    expect(row.status).toBe('failed')
    expect(row.errorCode).toBe('RECEIPT_LOST')
    expect(row.tasks.echo_a).toMatchObject({ outcome: 'fail', errorCode: 'RECEIPT_LOST' })
    expect(row.tasks.echo_b?.outcome).toBe('skip')
  })

  it('replays a memoized stale load while D1 holds started: 0 port calls, RECEIPT_LOST', async () => {
    const db = createMemoryDb()
    await seedRun(db, {
      runId: 'run_replay',
      planYaml: CHAIN_INVOKE_PLAN_YAML,
      status: 'running',
      tasks: { echo_a: { outcome: 'started' } },
    })
    const stale = await loadRun(db, 'run_replay', SEED_ORG)
    if (!stale) throw new Error('seed missing')
    const cache = new Map<string, unknown>([
      ['claim', undefined],
      [
        'load',
        { ...stale, receipt_json: JSON.stringify({ receiptVersion: 1, tokensUsed: 0, tasks: {} }) },
      ],
    ])
    let calls = 0
    await expect(
      driveFlowRun({
        step: memoStep(cache),
        db,
        invoke: async () => {
          calls += 1
          return { output: 'twice' }
        },
        payload: { runId: 'run_replay', orgId: SEED_ORG },
        instanceId: 'wfinst_replay',
      }),
    ).rejects.toMatchObject({ message: 'RECEIPT_LOST' })
    expect(calls).toBe(0)
    const row = await taskReceipts(db, 'run_replay')
    expect(row.status).toBe('failed')
    expect(row.errorCode).toBe('RECEIPT_LOST')
  })

  it('closes an orphaned started receipt when the terminal task write fails transiently', async () => {
    const db = createMemoryDb()
    await seedRun(db, { runId: 'run_orphan', planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    let calls = 0
    let failed = false
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          return { output: 'done' }
        },
        persistBundle: async (database, input) => {
          if (!failed && input.receiptJson.includes('"outcome":"ok"')) {
            failed = true
            throw new Error('D1 transient')
          }
          return persistBundle(database, input)
        },
        payload: { runId: 'run_orphan', orgId: SEED_ORG },
        instanceId: 'wfinst_orphan',
      }),
    ).rejects.toThrow('D1 transient')
    expect(calls).toBe(1)
    const row = await taskReceipts(db, 'run_orphan')
    expect(row.status).toBe('failed')
    expect(row.errorCode).toBe('RECEIPT_LOST')
    expect(row.tasks.echo_hello).toMatchObject({ outcome: 'fail', errorCode: 'RECEIPT_LOST' })
  })

  it('scrubs the started receipt without changing a cancellation that races the orphan close', async () => {
    const db = createMemoryDb()
    await seedRun(db, { runId: 'run_cancel', planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    let calls = 0
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          await db
            .prepare(
              `UPDATE flow_runs SET status = 'cancelled', error_code = 'CANCELLED_BY_USER' WHERE id = ? AND org_id = ?`,
            )
            .bind('run_cancel', SEED_ORG)
            .run()
          return { output: 'too-late' }
        },
        payload: { runId: 'run_cancel', orgId: SEED_ORG },
        instanceId: 'wfinst_cancel',
      }),
    ).rejects.toMatchObject({ name: 'DriveNonRetryableError', message: 'cancelled' })
    expect(calls).toBe(1)
    const row = await taskReceipts(db, 'run_cancel')
    expect(row.status).toBe('cancelled')
    expect(row.errorCode).toBe('CANCELLED_BY_USER')
    expect(row.tasks.echo_hello).toMatchObject({ outcome: 'fail', errorCode: 'RECEIPT_LOST' })
    expect(await loadRun(db, 'run_cancel', SEED_ORG)).toMatchObject({
      status: 'cancelled',
      error_code: 'CANCELLED_BY_USER',
      workflow_instance_id: 'wfinst_cancel',
    })
    const events = await db
      .prepare(`SELECT outcome, error_code FROM flow_run_events
      WHERE run_id = ? AND kind = 'receipt' ORDER BY seq`)
      .bind('run_cancel')
      .all<{ outcome: string; error_code: string | null }>()
    expect(events.results).toEqual([
      { outcome: 'started', error_code: null },
      { outcome: 'fail', error_code: 'RECEIPT_LOST' },
    ])
  })

  it('rolls back the terminal scrub when its receipt event is rejected', async () => {
    const db = createMemoryDb()
    const runId = 'run_cancel_scrub_abort'
    await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    await db
      .prepare(`CREATE TRIGGER reject_terminal_scrub BEFORE INSERT ON flow_run_events
      WHEN NEW.run_id = 'run_cancel_scrub_abort' AND NEW.kind = 'receipt'
        AND NEW.outcome = 'fail' AND NEW.error_code = 'RECEIPT_LOST'
        AND EXISTS (SELECT 1 FROM flow_runs WHERE id = NEW.run_id AND org_id = NEW.org_id
          AND status = 'cancelled'
          AND json_extract(receipt_json, '$.tasks.echo_hello.outcome') = 'fail')
      BEGIN SELECT RAISE(ABORT, 'terminal scrub event rejected'); END`)
      .run()
    let calls = 0
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          await db
            .prepare(`UPDATE flow_runs SET status = 'cancelled', error_code = 'CANCELLED_BY_USER'
          WHERE id = ? AND org_id = ?`)
            .bind(runId, SEED_ORG)
            .run()
          return { output: 'too-late' }
        },
        payload: { runId, orgId: SEED_ORG },
        instanceId: 'wfinst_cancel_abort',
      }),
    ).rejects.toMatchObject({ name: 'DriveNonRetryableError', message: 'cancelled' })
    expect(calls).toBe(1)
    const row = await taskReceipts(db, runId)
    expect(row.status).toBe('cancelled')
    expect(row.errorCode).toBe('CANCELLED_BY_USER')
    expect(row.tasks.echo_hello).toMatchObject({ outcome: 'started' })
    expect(await loadRun(db, runId, SEED_ORG)).toMatchObject({
      workflow_instance_id: 'wfinst_cancel_abort',
    })
    const events = await db
      .prepare(`SELECT outcome FROM flow_run_events
      WHERE run_id = ? AND kind = 'receipt' ORDER BY seq`)
      .bind(runId)
      .all<{ outcome: string }>()
    expect(events.results).toEqual([{ outcome: 'started' }])
  })

  it('does not scrub a cancelled run owned by a different instance', async () => {
    const db = createMemoryDb()
    const runId = 'run_cancel_other_owner'
    await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    let calls = 0
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          await db
            .prepare(`UPDATE flow_runs SET status = 'cancelled', error_code = 'CANCELLED_BY_USER',
          workflow_instance_id = 'wfinst_other' WHERE id = ? AND org_id = ?`)
            .bind(runId, SEED_ORG)
            .run()
          return { output: 'too-late' }
        },
        payload: { runId, orgId: SEED_ORG },
        instanceId: 'wfinst_original',
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
    const row = await taskReceipts(db, runId)
    expect(row.status).toBe('cancelled')
    expect(row.errorCode).toBe('CANCELLED_BY_USER')
    expect(row.tasks.echo_hello).toMatchObject({ outcome: 'started' })
    expect(await loadRun(db, runId, SEED_ORG)).toMatchObject({
      workflow_instance_id: 'wfinst_other',
    })
    const events = await db
      .prepare(`SELECT outcome FROM flow_run_events
      WHERE run_id = ? AND kind = 'receipt' ORDER BY seq`)
      .bind(runId)
      .all<{ outcome: string }>()
    expect(events.results).toEqual([{ outcome: 'started' }])
  })

  it('preserves malformed receipt bytes and the original error when closing an open run', async () => {
    const db = createMemoryDb()
    const runId = 'run_malformed_close'
    await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    const raw = '{malformed receipt'
    const original = new Error('load failed')
    await db.prepare('UPDATE flow_runs SET receipt_json = ? WHERE id = ?').bind(raw, runId).run()
    let calls = 0
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          return { output: 'unexpected' }
        },
        loadRun: async () => {
          throw original
        },
        payload: { runId, orgId: SEED_ORG },
        instanceId: 'wfinst_malformed',
      }),
    ).rejects.toBe(original)
    expect(calls).toBe(0)
    expect(await loadRun(db, runId, SEED_ORG)).toMatchObject({
      status: 'failed',
      error_code: null,
      receipt_json: raw,
      workflow_instance_id: 'wfinst_malformed',
    })
    const events = await db
      .prepare(`SELECT kind, status_from, status_to, error_code FROM flow_run_events
      WHERE run_id = ? ORDER BY seq`)
      .bind(runId)
      .all<{
        kind: string
        status_from: string | null
        status_to: string | null
        error_code: string | null
      }>()
    expect(events.results).toEqual([
      { kind: 'status', status_from: 'queued', status_to: 'running', error_code: null },
      { kind: 'status', status_from: 'running', status_to: 'failed', error_code: null },
    ])
  })

  it('closes a queued run without dispatch when the claimed status event aborts after CAS', async () => {
    const db = createMemoryDb()
    const runId = 'run_claim_event_abort'
    await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    await db
      .prepare(`CREATE TRIGGER reject_claim BEFORE INSERT ON flow_run_events
      WHEN NEW.kind = 'status' AND NEW.status_to = 'running'
        AND EXISTS (SELECT 1 FROM flow_runs WHERE id = NEW.run_id AND org_id = NEW.org_id
          AND status = 'running' AND workflow_instance_id = 'wfinst_claim_abort')
      BEGIN SELECT RAISE(ABORT, 'claim event rejected'); END`)
      .run()
    let calls = 0
    await expect(
      driveFlowRun({
        step: immediate,
        db,
        invoke: async () => {
          calls += 1
          return { output: 'unexpected' }
        },
        payload: { runId, orgId: SEED_ORG },
        instanceId: 'wfinst_claim_abort',
      }),
    ).rejects.toThrow()
    expect(calls).toBe(0)
    const row = await loadRun(db, runId, SEED_ORG)
    expect(row).toMatchObject({ status: 'failed', workflow_instance_id: null })
    const events = await db
      .prepare(`SELECT status_from, status_to FROM flow_run_events
      WHERE run_id = ? AND kind = 'status' ORDER BY seq`)
      .bind(runId)
      .all<{ status_from: string; status_to: string }>()
    expect(events.results).toEqual([{ status_from: 'queued', status_to: 'failed' }])
  })

  it('closes its committed claim after the acknowledgement is lost, without dispatch', async () => {
    const db = createMemoryDb()
    const runId = 'run_claim_ack'
    await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    const lostAck: DriveStep = async (name, fn) => {
      const result = await fn()
      if (name === 'claim') throw new Error('claim acknowledgement lost')
      return result
    }
    let calls = 0
    await expect(
      driveFlowRun({
        step: lostAck,
        db,
        invoke: async () => {
          calls += 1
          return { output: 'unexpected' }
        },
        payload: { runId, orgId: SEED_ORG },
        instanceId: 'wfinst_claim_ack',
      }),
    ).rejects.toThrow('claim acknowledgement lost')
    expect(calls).toBe(0)
    expect(await loadRun(db, runId, SEED_ORG)).toMatchObject({
      status: 'failed',
      workflow_instance_id: 'wfinst_claim_ack',
    })
    const events = await db
      .prepare(`SELECT status_from, status_to FROM flow_run_events
      WHERE run_id = ? AND kind = 'status' ORDER BY seq`)
      .bind(runId)
      .all<{ status_from: string; status_to: string }>()
    expect(events.results).toEqual([
      { status_from: 'queued', status_to: 'running' },
      { status_from: 'running', status_to: 'failed' },
    ])
  })

  it('never closes another instance claim when claim acknowledgement fails', async () => {
    const db = createMemoryDb()
    const runId = 'run_claim_other'
    await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
    expect(await claimRun(db, { runId, orgId: SEED_ORG, instanceId: 'wfinst_other' })).toBe(1)
    const before = await loadRun(db, runId, SEED_ORG)
    const failClaim: DriveStep = async (name, fn) => {
      const result = await fn()
      if (name === 'claim') throw new Error('claim acknowledgement lost')
      return result
    }
    let calls = 0
    await expect(
      driveFlowRun({
        step: failClaim,
        db,
        invoke: async () => {
          calls += 1
          return { output: 'unexpected' }
        },
        payload: { runId, orgId: SEED_ORG },
        instanceId: 'wfinst_not_owner',
      }),
    ).rejects.toThrow('claim acknowledgement lost')
    expect(calls).toBe(0)
    expect(await loadRun(db, runId, SEED_ORG)).toEqual(before)
    const events = await db
      .prepare(`SELECT status_from, status_to FROM flow_run_events
      WHERE run_id = ? AND kind = 'status' ORDER BY seq`)
      .bind(runId)
      .all<{ status_from: string; status_to: string }>()
    expect(events.results).toEqual([{ status_from: 'queued', status_to: 'running' }])
  })

  it.each(['started', 'ok'] as const)(
    'does not dispatch twice when the %s receipt event aborts',
    async (outcome) => {
      const db = createMemoryDb()
      const runId = `run_abort_${outcome}`
      await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
      await db
        .prepare(`CREATE TRIGGER reject_receipt BEFORE INSERT ON flow_run_events
        WHEN NEW.kind = 'receipt' AND NEW.outcome = '${outcome}' AND EXISTS (
          SELECT 1 FROM flow_runs WHERE id = NEW.run_id AND org_id = NEW.org_id
          AND status = 'running'
          AND json_extract(receipt_json, '$.tasks.echo_hello.outcome') = '${outcome}'
        )
        BEGIN SELECT RAISE(ABORT, 'receipt event rejected'); END`)
        .run()
      let calls = 0
      await expect(
        driveFlowRun({
          step: immediate,
          db,
          invoke: async () => {
            calls += 1
            return { output: 'done' }
          },
          payload: { runId, orgId: SEED_ORG },
          instanceId: 'wfinst_abort',
        }),
      ).rejects.toThrow()
      expect(calls).toBe(outcome === 'started' ? 0 : 1)
      const events = await db
        .prepare(`SELECT outcome FROM flow_run_events
        WHERE run_id = ? AND kind = 'receipt' ORDER BY seq`)
        .bind(runId)
        .all<{ outcome: string }>()
      expect(events.results.map((event) => event.outcome)).not.toContain(outcome)
      const row = await taskReceipts(db, runId)
      expect(row.status).toBe('failed')
      if (outcome === 'ok') {
        expect(row.tasks.echo_hello).toMatchObject({ outcome: 'fail', errorCode: 'RECEIPT_LOST' })
      } else {
        expect(row.tasks.echo_hello).toBeUndefined()
      }
    },
  )

  it.each(['started', 'ok'] as const)(
    'closes safely after a committed %s receipt loses its acknowledgement',
    async (outcome) => {
      const db = createMemoryDb()
      const runId = `run_lost_ack_${outcome}`
      await seedRun(db, { runId, planYaml: INVOKE_ONLY_PLAN_YAML, status: 'queued' })
      let calls = 0
      let lost = false
      await expect(
        driveFlowRun({
          step: immediate,
          db,
          invoke: async () => {
            calls += 1
            return { output: 'done' }
          },
          persistBundle: async (database, input) => {
            const changes = await persistBundle(database, input)
            if (!lost && input.receiptJson.includes(`"outcome":"${outcome}"`)) {
              lost = true
              throw new Error('lost acknowledgement')
            }
            return changes
          },
          payload: { runId, orgId: SEED_ORG },
          instanceId: 'wfinst_lost_ack',
        }),
      ).rejects.toThrow('lost acknowledgement')
      expect(lost).toBe(true)
      expect(calls).toBe(outcome === 'started' ? 0 : 1)
      const row = await taskReceipts(db, runId)
      expect(row.status).toBe('failed')
      expect(row.tasks.echo_hello).toMatchObject(
        outcome === 'started' ? { outcome: 'fail', errorCode: 'RECEIPT_LOST' } : { outcome: 'ok' },
      )
      const events = await db
        .prepare(`SELECT outcome FROM flow_run_events
        WHERE run_id = ? AND kind = 'receipt' ORDER BY seq`)
        .bind(runId)
        .all<{ outcome: string }>()
      expect(events.results.map((event) => event.outcome)).toEqual(
        outcome === 'started' ? ['started', 'fail'] : ['started', 'ok'],
      )
    },
  )
})
