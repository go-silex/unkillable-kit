import * as z from 'zod'
import { deepFreeze } from './freeze'
import {
  collectCeilingIssues,
  collectExecutionToolIssues,
  collectIdentityDigestIssues,
  collectRehydratePermitIssues,
  collectToolEffectIssues,
} from './runner-view-issues'
import type { PlanDocument } from './schema'
import { planDocumentSchema } from './schema'

/** Bump only with dual-parse / migrate story for D1 `snapshot_json`. */
export const RUNNER_VIEW_VERSION = 1 as const

/**
 * **Only** shape a runner may rehydrate from durable storage (ADR-0005).
 * Never contains grant allowlist super-set — audit grant is separate.
 *
 * **Contract:** Roxabi/roxabi-boilerplate-cf#30 must `parseRunnerView` on every read — raw `JSON.parse` is not
 * a supported rehydrate path (convention until import-boundary/lint on Workflow module).
 */
export type RunnerView = {
  runnerViewVersion: typeof RUNNER_VIEW_VERSION
  orgId: string
  actorId: string
  planId: string
  planDigest: string
  sealedPlan: PlanDocument
  /**
   * **Only** tool names a runner may invoke (grant ∩ permits ∩ registry at seal).
   * Dispatch MUST use this set — not sealedPlan task names alone without intersection.
   */
  executionTools: readonly string[]
  /**
   * Sealed retry hints for `executionTools` (Roxabi/roxabi-boilerplate-cf#234). Emitted only when at least one tool is
   * `'read'` so all-write seals omit the key and stay parseable by pre-Roxabi/roxabi-boilerplate-cf#234 `.strict()` schemas
   * without bumping `RUNNER_VIEW_VERSION`. Absent map ⇒ every tool is write (no kit retry).
   * Driver reads this map, not the live registry (invariant 2). Unknown name ⇒ write.
   */
  toolEffects?: Readonly<Record<string, 'read' | 'write'>>
  registryVersion: string
  registryContentDigest: string
  ceilings: {
    hardMaxTokens: number
    staticTokenBudget: number
    planMaxTokens?: number
  }
  allowsInfer: boolean
  createdAt: string
}

export type ParseRunnerViewResult =
  | { ok: true; runnerView: RunnerView }
  | { ok: false; issues: Array<{ code: string; message: string; path?: string }> }

const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)

/**
 * Structural schema for durable rehydrate.
 * `.strict()` rejects grantAudit / effectivePermits / grantSnapshot / maxTokens alias.
 */
export const runnerViewSchema = z
  .object({
    runnerViewVersion: z.literal(RUNNER_VIEW_VERSION),
    orgId: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256),
    planId: z.string().min(1).max(128),
    planDigest: z.string().min(1).max(64),
    sealedPlan: planDocumentSchema,
    executionTools: z.array(toolNameSchema).max(256),
    /** Optional: absent on pre-Roxabi/roxabi-boilerplate-cf#234 snapshots ⇒ treat every tool as write. */
    toolEffects: z.record(toolNameSchema, z.enum(['read', 'write'])).optional(),
    registryVersion: z.string().min(1).max(256),
    registryContentDigest: z.string().min(1).max(64),
    ceilings: z
      .object({
        hardMaxTokens: z.number().int().nonnegative(),
        staticTokenBudget: z.number().int().nonnegative(),
        planMaxTokens: z.number().int().positive().optional(),
      })
      .strict(),
    allowsInfer: z.boolean(),
    createdAt: z.string().min(1).max(64),
  })
  .strict()

/** Tools a runner may invoke from a sealed runner view. */
export function executionTools(view: RunnerView): readonly string[] {
  return view.executionTools
}

/**
 * Fail-closed rehydrate for Roxabi/roxabi-boilerplate-cf#30 Workflows / D1.
 * Consistency checks (not full grant re-mint): tools, infer, ceilings, digests.
 * Does **not** prove grant provenance — mint is `mintCapabilityGrant` at create-run, not rehydrate.
 */
export function parseRunnerView(input: unknown): ParseRunnerViewResult {
  const parsed = runnerViewSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((zi) => ({
        code: 'RUNNER_VIEW_INVALID',
        message: zi.message,
        path: zi.path.length ? zi.path.join('.') : undefined,
      })),
    }
  }
  const data = parsed.data
  const identity = collectIdentityDigestIssues(data.planId, data.planDigest, data.sealedPlan)
  const ceilings = collectCeilingIssues(data.sealedPlan, data.ceilings)
  const issues = [
    ...collectExecutionToolIssues(data.sealedPlan, data.executionTools),
    ...collectRehydratePermitIssues(data.sealedPlan, data.allowsInfer),
    ...identity.issues,
    ...ceilings.issues,
    ...collectToolEffectIssues(data.executionTools, data.toolEffects),
  ]
  if (issues.length > 0) return { ok: false, issues }

  const runnerView: RunnerView = {
    runnerViewVersion: RUNNER_VIEW_VERSION,
    orgId: data.orgId,
    actorId: data.actorId,
    planId: data.planId,
    planDigest: identity.expectedDigest,
    sealedPlan: data.sealedPlan,
    executionTools: Object.freeze([...data.executionTools]) as readonly string[],
    ...(data.toolEffects !== undefined
      ? { toolEffects: Object.freeze({ ...data.toolEffects }) }
      : {}),
    registryVersion: data.registryVersion,
    registryContentDigest: data.registryContentDigest,
    ceilings: {
      hardMaxTokens: ceilings.expectedHard,
      staticTokenBudget: ceilings.expectedStatic,
      ...(ceilings.planMax !== undefined ? { planMaxTokens: ceilings.planMax } : {}),
    },
    allowsInfer: data.allowsInfer,
    createdAt: data.createdAt,
  }

  return { ok: true, runnerView: deepFreeze(runnerView) }
}
