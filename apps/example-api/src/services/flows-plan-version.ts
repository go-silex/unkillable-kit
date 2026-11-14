import { AppError } from '@kit/core'
import { digestPlan, type PlanDocument, sha256Hex } from '@kit/flows'
import type { FlowPlanRow } from '@kit/flows/repos'
import * as flowsRepo from '@kit/flows/repos'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'

type Db = DrizzleD1Database<typeof schema>

const yamlEncoder = new TextEncoder()

export type PlanVersionInsert = {
  row: FlowPlanRow
  status: 200 | 201
}

async function lowestConfirmedByteMatch(
  db: Db,
  orgId: string,
  planKey: string,
  yaml: string,
): Promise<FlowPlanRow | null> {
  const row = await flowsRepo.getLowestPlanVersionByBytes(db, orgId, planKey, yaml)
  const postedSha = await sha256Hex(yamlEncoder.encode(yaml))
  const rowSha =
    row?.yamlSource == null ? null : await sha256Hex(yamlEncoder.encode(row.yamlSource))
  if (!row || rowSha !== postedSha) return null
  return row
}

/**
 * Identity is the posted YAML bytes, SHA-256 confirmed. One atomic statement inserts
 * version MAX+1 only when no row in this org and key stores the same bytes. Overlapping
 * publishes of the same bytes leave one row. Then the lowest byte-equal version is
 * re-read. On a version-unique failure the same re-read runs: identical bytes → 200,
 * otherwise 409 `PLAN_VERSION_RACE`. `plan_digest` (FNV) is stored as an index and never
 * consulted for identity. `checkPlan` has already run. A match does not rewrite the row.
 */
export async function insertOrMatchPlanVersion(
  db: Db,
  input: { orgId: string; subject: string; yaml: string; plan: PlanDocument },
): Promise<PlanVersionInsert> {
  const planKey = input.plan.plan.id
  const now = Date.now()
  const outcome = await flowsRepo.insertPlanVersionIfNewBytes(db, {
    id: `plan_${crypto.randomUUID().replace(/-/g, '')}`,
    orgId: input.orgId,
    planKey,
    yamlSource: input.yaml,
    planJson: JSON.stringify(input.plan),
    planDigest: digestPlan(input.plan),
    createdBy: input.subject,
    createdAt: now,
    updatedAt: now,
  })
  if (!outcome.ok) {
    const winner = await lowestConfirmedByteMatch(db, input.orgId, planKey, input.yaml)
    if (winner) return { row: winner, status: 200 }
    throw AppError.conflict('Plan version race; retry the publish', {
      reason: 'PLAN_VERSION_RACE',
      retryable: true,
    })
  }
  const row = await lowestConfirmedByteMatch(db, input.orgId, planKey, input.yaml)
  if (!row) {
    throw new Error('flow_plans byte lookup did not return the published YAML')
  }
  return { row, status: outcome.inserted ? 201 : 200 }
}
