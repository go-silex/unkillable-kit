import { createDb } from '@kit/db'
import * as flowsRepo from '@kit/flows/repos'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { flowRuns, schema } from '../db/schema'
import { createMemoryEnv } from '../test/memory-env'

const ORG = 'org_acme'
const PLAN_ID = 'plan_gated'

async function seedPlan(enabled = true) {
  const env = createMemoryEnv()
  const db = createDb(env.DB as unknown as D1Database, schema)
  const now = Date.now()
  await flowsRepo.insertPlan(db, {
    id: PLAN_ID,
    orgId: ORG,
    planKey: 'echo-only',
    version: 1,
    enabled,
    planJson: '{}',
    planDigest: 'digest_plan',
    createdAt: now,
    updatedAt: now,
  })
  return db
}

describe('insertPlan', () => {
  it('returns conflict when the same org key is inserted again', async () => {
    const db = await seedPlan()
    const again = await flowsRepo.insertPlan(db, {
      id: 'plan_dup',
      orgId: ORG,
      planKey: 'echo-only',
      version: 1,
      enabled: true,
      planJson: '{}',
      planDigest: 'digest_plan',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    expect(again).toEqual({ ok: false, reason: 'conflict' })
  })

  it('throws a NOT NULL error even when planKey contains unique', async () => {
    const db = await seedPlan()
    await expect(
      flowsRepo.insertPlan(db, {
        id: 'plan_null_json',
        orgId: ORG,
        planKey: 'unique_plan',
        version: 1,
        enabled: true,
        planJson: undefined as unknown as string,
        planDigest: 'digest_plan',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ).rejects.toThrow()
  })
})

function queuedRow(id: string, now = Date.now()) {
  return {
    id,
    orgId: ORG,
    planId: PLAN_ID,
    actorId: 'user_staff',
    snapshotJson: '{"planId":"echo-only"}',
    createdAt: now,
    updatedAt: now,
  }
}

describe('insertQueuedRunIfPlanEnabled', () => {
  it('inserts queued when the plan is enabled and copies plan_key + digest', async () => {
    const db = await seedPlan(true)
    const ok = await flowsRepo.insertQueuedRunIfPlanEnabled(db, queuedRow('run_ok'))
    expect(ok).toBe(true)
    const row = await flowsRepo.getRun(db, 'run_ok', ORG)
    expect(row?.status).toBe('queued')
    expect(row?.planKey).toBe('echo-only')
    expect(row?.planDigest).toBe('digest_plan')
    expect(row?.snapshotJson).toContain('echo-only')
  })

  it('returns false and writes no row when the plan is disabled', async () => {
    const db = await seedPlan(false)
    const ok = await flowsRepo.insertQueuedRunIfPlanEnabled(db, queuedRow('run_off'))
    expect(ok).toBe(false)
    expect(await flowsRepo.getRun(db, 'run_off', ORG)).toBeNull()
    const rows = await db.select().from(flowRuns).where(eq(flowRuns.orgId, ORG)).all()
    expect(rows).toEqual([])
  })

  it('returns false after setPlanEnabled(false) on a previously enabled plan', async () => {
    const db = await seedPlan(true)
    await flowsRepo.setPlanEnabled(db, { id: PLAN_ID, orgId: ORG, enabled: false })
    expect(await flowsRepo.insertQueuedRunIfPlanEnabled(db, queuedRow('run_after_off'))).toBe(false)
    expect(await flowsRepo.getRun(db, 'run_after_off', ORG)).toBeNull()
  })

  it('returns false when the plan id is missing or org does not match', async () => {
    const db = await seedPlan(true)
    const missing = await flowsRepo.insertQueuedRunIfPlanEnabled(db, {
      ...queuedRow('run_ghost'),
      planId: 'plan_missing',
    })
    expect(missing).toBe(false)
    const wrongOrg = await flowsRepo.insertQueuedRunIfPlanEnabled(db, {
      ...queuedRow('run_wrong_org'),
      orgId: 'org_other',
    })
    expect(wrongOrg).toBe(false)
    expect(await flowsRepo.getRun(db, 'run_ghost', ORG)).toBeNull()
    expect(await flowsRepo.getRun(db, 'run_wrong_org', 'org_other')).toBeNull()
  })
})

describe('markQueuedRunCreateFailed', () => {
  it('CAS queued → failed once; second call is 0 and leaves WORKFLOW_CREATE_FAILED', async () => {
    const db = await seedPlan(true)
    expect(await flowsRepo.insertQueuedRunIfPlanEnabled(db, queuedRow('run_cas'))).toBe(true)
    expect(await flowsRepo.markQueuedRunCreateFailed(db, { id: 'run_cas', orgId: ORG })).toBe(true)
    const first = await flowsRepo.getRun(db, 'run_cas', ORG)
    expect(first?.status).toBe('failed')
    expect(first?.errorCode).toBe('WORKFLOW_CREATE_FAILED')
    expect(await flowsRepo.markQueuedRunCreateFailed(db, { id: 'run_cas', orgId: ORG })).toBe(false)
    const second = await flowsRepo.getRun(db, 'run_cas', ORG)
    expect(second?.status).toBe('failed')
    expect(second?.errorCode).toBe('WORKFLOW_CREATE_FAILED')
  })

  it('does not mark a non-queued row', async () => {
    const db = await seedPlan(true)
    expect(await flowsRepo.insertQueuedRunIfPlanEnabled(db, queuedRow('run_running'))).toBe(true)
    await db
      .update(flowRuns)
      .set({ status: 'running', updatedAt: Date.now() })
      .where(eq(flowRuns.id, 'run_running'))
      .run()
    expect(await flowsRepo.markQueuedRunCreateFailed(db, { id: 'run_running', orgId: ORG })).toBe(
      false,
    )
    const row = await flowsRepo.getRun(db, 'run_running', ORG)
    expect(row?.status).toBe('running')
    expect(row?.errorCode).toBeNull()
  })
})
