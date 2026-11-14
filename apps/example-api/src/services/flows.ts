import { AppError, createLogger, parseOrThrow } from '@kit/core'
import {
  canAdminFlows,
  canCreateFlowRun,
  checkPlan,
  createRunSnapshot,
  loadPlanFromYaml,
  type PlanDocument,
  PlanYamlError,
  parseRunnerView,
  readRunRollup,
} from '@kit/flows'
import * as flowsRepo from '@kit/flows/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import type { Env } from '../env'
import {
  createPlanBodySchema,
  createRunBodySchema,
  setEnabledBodySchema,
} from '../lib/flows-body-schemas'
import { dogfoodToolRegistry } from '../lib/flows-dogfood'
import { allowedModelsForPlan, mintGrantForOrg } from './flows-grant'
import { insertOrMatchPlanVersion } from './flows-plan-version'

type Db = DrizzleD1Database<typeof schema>
type PlanRow = typeof import('../db/schema').flowPlans.$inferSelect
type RunRow = typeof import('../db/schema').flowRuns.$inferSelect

const log = createLogger({ service: 'example-api', component: 'flows' })

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toPublicPlan(row: PlanRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    planKey: row.planKey,
    version: row.version,
    enabled: row.enabled,
    digest: row.planDigest,
  }
}

function toPublicRun(row: RunRow) {
  const rollup = readRunRollup({
    status: row.status,
    receiptJson: row.receiptJson,
    errorCode: row.errorCode,
  })
  return {
    id: row.id,
    orgId: row.orgId,
    planId: row.planId,
    status: rollup.status,
    receipts: rollup.receipts,
    errorCode: rollup.errorCode ?? null,
  }
}

export async function listPlansForOrg(db: Db, orgId: string) {
  const rows = await flowsRepo.listPlansForOrg(db, orgId)
  return rows.map(toPublicPlan)
}

export async function getPlanForOrg(db: Db, orgId: string, planId: string) {
  const row = await flowsRepo.getPlan(db, planId, orgId)
  if (!row) throw AppError.notFound()
  return toPublicPlan(row)
}

export async function listRunsForOrg(db: Db, orgId: string) {
  const rows = await flowsRepo.listRunsForOrg(db, orgId)
  return rows.map(toPublicRun)
}

export async function getRunForOrg(db: Db, orgId: string, runId: string) {
  const row = await flowsRepo.getRun(db, runId, orgId)
  if (!row) throw AppError.notFound()
  return toPublicRun(row)
}

async function loadCheckedPlan(
  db: Db,
  env: { FLOW_ALLOWED_MODELS?: string },
  input: {
    orgId: string
    orgRole: string | null | undefined
    body: unknown
  },
): Promise<{ yaml: string; plan: PlanDocument }> {
  if (!canAdminFlows({ orgRole: input.orgRole })) {
    throw AppError.forbidden()
  }
  const { yaml } = parseOrThrow(createPlanBodySchema, input.body)
  let plan: PlanDocument
  try {
    plan = loadPlanFromYaml(yaml)
  } catch (err) {
    if (err instanceof PlanYamlError) {
      throw AppError.validation(err.message, { code: err.code })
    }
    throw err
  }
  const grant = await mintGrantForOrg(
    db,
    input.orgId,
    input.orgRole,
    allowedModelsForPlan(env.FLOW_ALLOWED_MODELS, plan),
  )
  const checked = checkPlan(plan, grant, dogfoodToolRegistry)
  if (!checked.ok) {
    throw AppError.validation(checked.issues[0]?.message ?? 'Plan check failed', {
      issues: checked.issues,
    })
  }
  return { yaml, plan }
}

export async function checkPlanYaml(
  db: Db,
  env: { FLOW_ALLOWED_MODELS?: string },
  input: {
    orgId: string
    orgRole: string | null | undefined
    body: unknown
  },
) {
  await loadCheckedPlan(db, env, input)
}

export async function createPlan(
  db: Db,
  env: { FLOW_ALLOWED_MODELS?: string },
  input: {
    orgId: string
    subject: string
    orgRole: string | null | undefined
    body: unknown
  },
) {
  const { yaml, plan } = await loadCheckedPlan(db, env, input)
  const published = await insertOrMatchPlanVersion(db, {
    orgId: input.orgId,
    subject: input.subject,
    yaml,
    plan,
  })
  return { plan: toPublicPlan(published.row), status: published.status }
}

export async function setEnabled(
  db: Db,
  input: {
    orgId: string
    planId: string
    orgRole: string | null | undefined
    body: unknown
  },
) {
  if (!canAdminFlows({ orgRole: input.orgRole })) {
    throw AppError.forbidden()
  }
  const { enabled } = parseOrThrow(setEnabledBodySchema, input.body)
  const existing = await flowsRepo.getPlan(db, input.planId, input.orgId)
  if (!existing) throw AppError.notFound()
  await flowsRepo.setPlanEnabled(db, { id: input.planId, orgId: input.orgId, enabled })
  const updated = await flowsRepo.getPlan(db, input.planId, input.orgId)
  if (!updated) throw AppError.notFound()
  return toPublicPlan(updated)
}
async function parseStoredPlan(planJson: string): Promise<unknown> {
  try {
    return JSON.parse(planJson) as unknown
  } catch {
    throw AppError.validation('Invalid stored plan')
  }
}

async function snapshotForCreateRun(input: {
  db: Db
  orgId: string
  orgRole: string | null | undefined
  subject: string
  plan: unknown
  allowedModels: readonly string[]
}): Promise<string> {
  const grant = await mintGrantForOrg(input.db, input.orgId, input.orgRole, input.allowedModels)
  const snap = createRunSnapshot({
    plan: input.plan,
    grant,
    registry: dogfoodToolRegistry,
    actorId: input.subject,
  })
  if (!snap.ok) {
    throw AppError.validation(snap.issues[0]?.message ?? 'Snapshot failed', {
      issues: snap.issues,
    })
  }
  const snapshotJson = JSON.stringify(snap.runnerView)
  const parsed = parseRunnerView(JSON.parse(snapshotJson) as unknown)
  if (!parsed.ok) {
    throw AppError.validation(parsed.issues[0]?.message ?? 'Runner view invalid', {
      issues: parsed.issues,
    })
  }
  return snapshotJson
}

async function failWorkflowCreate(
  db: Db,
  runId: string,
  orgId: string,
  err: unknown,
): Promise<never> {
  log.error('flow_run_create_failed', {
    runId,
    orgId,
    error: errorMessage(err),
  })
  let marked = false
  try {
    marked = await flowsRepo.markQueuedRunCreateFailed(db, { id: runId, orgId })
  } catch (markErr) {
    log.error('flow_run_mark_create_failed', {
      runId,
      orgId,
      error: errorMessage(markErr),
    })
    throw AppError.internal()
  }
  if (!marked) {
    const row = await flowsRepo.getRun(db, runId, orgId)
    if (row?.status === 'failed' && row.errorCode === 'WORKFLOW_CREATE_FAILED') {
      throw new AppError('INTERNAL_ERROR', 'Internal error', 502)
    }
    throw AppError.internal()
  }
  throw new AppError('INTERNAL_ERROR', 'Internal error', 502)
}

export async function createRun(
  db: Db,
  env: Pick<Env, 'FLOW_RUN' | 'FLOW_ALLOWED_MODELS'>,
  input: {
    orgId: string
    planId: string
    subject: string
    orgRole: string | null | undefined
    authMethod: 'session' | 'api_key' | null | undefined
    body: unknown
  },
) {
  if (
    !canCreateFlowRun({
      orgRole: input.orgRole,
      authMethod: input.authMethod,
    })
  ) {
    throw AppError.forbidden()
  }
  parseOrThrow(createRunBodySchema, input.body)
  const existing = await flowsRepo.getPlan(db, input.planId, input.orgId)
  if (!existing) throw AppError.notFound()
  const plan = await parseStoredPlan(existing.planJson)
  const snapshotJson = await snapshotForCreateRun({
    db,
    orgId: input.orgId,
    orgRole: input.orgRole,
    subject: input.subject,
    plan,
    allowedModels: allowedModelsForPlan(env.FLOW_ALLOWED_MODELS, plan),
  })
  const runId = `run_${crypto.randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  const inserted = await flowsRepo.insertQueuedRunIfPlanEnabled(db, {
    id: runId,
    orgId: input.orgId,
    planId: existing.id,
    actorId: input.subject,
    snapshotJson,
    createdAt: now,
    updatedAt: now,
  })
  if (!inserted) {
    const again = await flowsRepo.getPlan(db, input.planId, input.orgId)
    if (!again) throw AppError.notFound()
    if (!again.enabled) throw AppError.conflict('Plan is disabled')
    throw AppError.internal()
  }
  try {
    await env.FLOW_RUN.create({ id: runId, params: { runId, orgId: input.orgId } })
  } catch (err) {
    await failWorkflowCreate(db, runId, input.orgId, err)
  }
  return { id: runId, status: 'queued' as const }
}
