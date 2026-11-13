import { describe, expect, it } from 'vitest'
import {
  createRunSnapshot,
  createToolRegistry,
  loadPlanFromYaml,
  mintCapabilityGrant,
  RECEIPT_OUTPUT_MAX_CHARS,
  REDACTED_OUTPUT_MARKER,
} from '..'
import type { DriveStep } from './drive'
import { INVOKE_ONLY_PLAN_YAML } from './fixtures'
import { runInvokeStep } from './invoke-step'
import { persistBundle } from './persist'
import { redactReceiptOutput, type StepReceiptCtx } from './step-io'
import { createMemoryDb } from './test/memory-db'

const ORG = 'org_a'

const registry = createToolRegistry('example-api-drive-v0', [
  { name: 'echo', description: 'Echo args', grantClass: 'mintable' },
])

function mintGrant() {
  const minted = mintCapabilityGrant({
    orgId: ORG,
    registry,
    facts: { moduleEffective: true, canRead: true, canWrite: false, allowedModels: [] },
  })
  if (!minted.ok) throw new Error(minted.message)
  return minted.grant
}

function sealView() {
  const plan = loadPlanFromYaml(INVOKE_ONLY_PLAN_YAML)
  const result = createRunSnapshot({
    plan,
    grant: mintGrant(),
    registry,
    actorId: 'actor_1',
  })
  if (!result.ok) throw new Error(result.issues.map((i) => i.code).join(','))
  return result.runnerView
}

async function seedRun(db: ReturnType<typeof createMemoryDb>, runId: string, snapshotJson: string) {
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO flow_plans (id, org_id, plan_key, version, enabled, plan_json, plan_digest, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, '{}', 'digest', ?, ?)`,
    )
    .bind(`plan_${runId}`, ORG, 'echo-only', now, now)
    .run()
  await db
    .prepare(
      `INSERT INTO flow_runs (
        id, org_id, plan_id, plan_key, status, actor_id, snapshot_json, plan_digest, receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, 'digest', ?, ?, ?)`,
    )
    .bind(
      runId,
      ORG,
      `plan_${runId}`,
      'echo-only',
      'actor_1',
      snapshotJson,
      JSON.stringify({ receiptVersion: 1, tokensUsed: 0, tasks: {} }),
      now,
      now,
    )
    .run()
}

const BINDING_DOLLAR = '$'
const ph = (id: string) => `${BINDING_DOLLAR}{{ tasks.${id}.output }}`

describe('redactReceiptOutput', () => {
  it('replaces sensitive text with the marker before any cap', () => {
    expect(redactReceiptOutput('secret-token-value', true)).toBe(REDACTED_OUTPUT_MARKER)
    expect(redactReceiptOutput('ok', false)).toBe('ok')
    expect(redactReceiptOutput(undefined, true)).toBeUndefined()
  })

  it('caps unflagged output at RECEIPT_OUTPUT_MAX_CHARS', () => {
    const raw = 'x'.repeat(RECEIPT_OUTPUT_MAX_CHARS + 12)
    expect(redactReceiptOutput(raw, false)?.length).toBe(RECEIPT_OUTPUT_MAX_CHARS)
  })
})

describe('runInvokeStep — write-time redaction', () => {
  it('persists the marker and omits raw text when isSensitive is true', async () => {
    const db = createMemoryDb()
    const view = sealView()
    const runId = 'run_redact_sensitive'
    await seedRun(db, runId, JSON.stringify(view))
    const io: StepReceiptCtx = {
      persist: persistBundle,
      load: async (database, id, orgId) =>
        (await database
          .prepare(
            `SELECT id, org_id, status, snapshot_json, receipt_json, error_code FROM flow_runs WHERE id = ? AND org_id = ?`,
          )
          .bind(id, orgId)
          .first()) as never,
      db,
      ids: { runId, orgId: ORG },
      taskIds: Object.keys(view.sealedPlan.tasks),
    }
    let stepReturn: unknown
    const step: DriveStep = async (_name, fn) => {
      stepReturn = await fn()
      return stepReturn as never
    }
    const secret = 'raw-secret-should-not-land'

    await runInvokeStep({
      step,
      invoke: async () => ({ output: secret }),
      hasTool: () => true,
      isSensitive: () => true,
      view,
      taskId: 'echo_hello',
      tool: 'echo',
      io,
    })

    const row = (await db
      .prepare(`SELECT receipt_json FROM flow_runs WHERE id = ? AND org_id = ?`)
      .bind(runId, ORG)
      .first()) as { receipt_json: string }
    expect(row.receipt_json).not.toContain(secret)
    const bundle = JSON.parse(row.receipt_json) as {
      tasks: { echo_hello?: { outcome?: string; output?: string } }
    }
    expect(bundle.tasks.echo_hello?.outcome).toBe('ok')
    expect(bundle.tasks.echo_hello?.output).toBe(REDACTED_OUTPUT_MARKER)
    expect(stepReturn).toEqual({ outcome: 'ok' })
    expect(stepReturn).not.toHaveProperty('output')
  })

  it('stores capped raw output when the tool is not sensitive', async () => {
    const db = createMemoryDb()
    const view = sealView()
    const runId = 'run_redact_plain'
    await seedRun(db, runId, JSON.stringify(view))
    const io: StepReceiptCtx = {
      persist: persistBundle,
      load: async (database, id, orgId) =>
        (await database
          .prepare(
            `SELECT id, org_id, status, snapshot_json, receipt_json, error_code FROM flow_runs WHERE id = ? AND org_id = ?`,
          )
          .bind(id, orgId)
          .first()) as never,
      db,
      ids: { runId, orgId: ORG },
      taskIds: Object.keys(view.sealedPlan.tasks),
    }
    const step: DriveStep = async (_name, fn) => fn()
    const raw = `plain-${'y'.repeat(RECEIPT_OUTPUT_MAX_CHARS)}`

    await runInvokeStep({
      step,
      invoke: async () => ({ output: raw }),
      hasTool: () => true,
      view,
      taskId: 'echo_hello',
      tool: 'echo',
      io,
    })

    const row = (await db
      .prepare(`SELECT receipt_json FROM flow_runs WHERE id = ? AND org_id = ?`)
      .bind(runId, ORG)
      .first()) as { receipt_json: string }
    const bundle = JSON.parse(row.receipt_json) as {
      tasks: { echo_hello?: { output?: string } }
    }
    expect(bundle.tasks.echo_hello?.output).toBe(raw.slice(0, RECEIPT_OUTPUT_MAX_CHARS))
    expect(bundle.tasks.echo_hello?.output?.startsWith('plain-')).toBe(true)
  })
})

describe('runInvokeStep — whole-value bindings (Roxabi/roxabi-boilerplate-cf#232)', () => {
  async function harness(runId: string) {
    const db = createMemoryDb()
    const view = sealView()
    await seedRun(db, runId, JSON.stringify(view))
    const io: StepReceiptCtx = {
      persist: persistBundle,
      load: async (database, id, orgId) =>
        (await database
          .prepare(
            `SELECT id, org_id, status, snapshot_json, receipt_json, error_code FROM flow_runs WHERE id = ? AND org_id = ?`,
          )
          .bind(id, orgId)
          .first()) as never,
      db,
      ids: { runId, orgId: ORG },
      taskIds: Object.keys(view.sealedPlan.tasks),
    }
    const step: DriveStep = async (_name, fn) => fn()
    return { db, view, io, step }
  }

  it('does not call the tool and records BINDING_UNRESOLVED when output is missing', async () => {
    const { view, io, step } = await harness('run_bind_missing')
    let called = 0
    await runInvokeStep({
      step,
      invoke: async () => {
        called += 1
        return { output: 'nope' }
      },
      hasTool: () => true,
      view,
      taskId: 'echo_hello',
      tool: 'echo',
      args: { text: ph('prior') },
      io,
    })
    expect(called).toBe(0)
    const row = (await io.db
      .prepare(`SELECT receipt_json FROM flow_runs WHERE id = ? AND org_id = ?`)
      .bind(io.ids.runId, ORG)
      .first()) as { receipt_json: string }
    const bundle = JSON.parse(row.receipt_json) as {
      tasks: { echo_hello?: { outcome?: string; errorCode?: string } }
    }
    expect(bundle.tasks.echo_hello).toEqual({
      taskId: 'echo_hello',
      outcome: 'fail',
      errorCode: 'BINDING_UNRESOLVED',
    })
  })

  it('passes resolved text to the tool, not the placeholder', async () => {
    const db = createMemoryDb()
    const plan = loadPlanFromYaml(
      [
        'flows: v0',
        'plan:',
        '  id: bind-ok',
        '  max_tokens: 100',
        'permits:',
        '  tools: [echo]',
        'tasks:',
        '  prior:',
        '    invoke:',
        '      tool: echo',
        '      args:',
        '        text: seed',
        '  later:',
        '    after: [prior]',
        '    invoke:',
        '      tool: echo',
        '      args:',
        `        text: "${ph('prior')}"`,
        '',
      ].join('\n'),
    )
    const grant = mintGrant()
    const snap = createRunSnapshot({
      plan,
      grant,
      registry,
      actorId: 'actor_1',
    })
    if (!snap.ok) throw new Error(snap.issues.map((i) => i.code).join(','))
    const view = snap.runnerView
    const runId = 'run_bind_ok'
    await seedRun(db, runId, JSON.stringify(view))
    const priorBundle = {
      receiptVersion: 1,
      tokensUsed: 0,
      tasks: { prior: { taskId: 'prior', outcome: 'ok', output: 'from-prior' } },
    }
    await db
      .prepare('UPDATE flow_runs SET receipt_json = ? WHERE id = ? AND org_id = ?')
      .bind(JSON.stringify(priorBundle), runId, ORG)
      .run()
    const io: StepReceiptCtx = {
      persist: persistBundle,
      load: async (database, id, orgId) =>
        (await database
          .prepare(
            'SELECT id, org_id, status, snapshot_json, receipt_json, error_code FROM flow_runs WHERE id = ? AND org_id = ?',
          )
          .bind(id, orgId)
          .first()) as never,
      db,
      ids: { runId, orgId: ORG },
      taskIds: Object.keys(view.sealedPlan.tasks),
    }
    const step: DriveStep = async (_name, fn) => fn()
    let seen: unknown
    await runInvokeStep({
      step,
      invoke: async (task) => {
        seen = task.args
        return { output: 'echoed' }
      },
      hasTool: () => true,
      view,
      taskId: 'later',
      tool: 'echo',
      args: { text: ph('prior') },
      io,
    })
    expect(seen).toEqual({ text: 'from-prior' })
  })
})
