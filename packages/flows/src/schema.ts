import * as z from 'zod'
import { FLOWS_VERSION, MAX_PERMIT_TOOLS, MAX_PLAN_TASKS, MAX_PLAN_TOTAL_TOKENS } from './constants'

const nonEmptyId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'id must be alphanumeric/underscore/hyphen')

/** Tool names share task-id charset (no path/injection-shaped names). */
const toolNameSchema = nonEmptyId

const MAX_ARGS_KEYS = 32
const MAX_ARG_STRING = 8_192
const MAX_ARG_DEPTH = 4

function argsIssuePath(path: string): (string | number)[] {
  return path ? path.split('.') : ['args']
}

function assertArgsString(value: string, path: string, ctx: z.RefinementCtx): void {
  if (value.length > MAX_ARG_STRING) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invoke.args string exceeds ${MAX_ARG_STRING} chars`,
      path: argsIssuePath(path),
    })
  }
}

function assertArgsArray(
  value: unknown[],
  depth: number,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (value.length > MAX_ARGS_KEYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invoke.args array length exceeds ${MAX_ARGS_KEYS}`,
      path: argsIssuePath(path),
    })
  }
  for (let i = 0; i < value.length; i++) {
    assertArgsShape(value[i], depth + 1, path ? `${path}.${i}` : String(i), ctx)
  }
}

function assertArgsObject(value: object, depth: number, path: string, ctx: z.RefinementCtx): void {
  const keys = Object.keys(value)
  if (keys.length > MAX_ARGS_KEYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invoke.args object has more than ${MAX_ARGS_KEYS} keys`,
      path: argsIssuePath(path),
    })
  }
  for (const k of keys) {
    if (/^__|constructor|prototype$/i.test(k) || k === '__proto__') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invoke.args key forbidden: ${k}`,
        path: argsIssuePath(path),
      })
    }
    assertArgsShape(
      (value as Record<string, unknown>)[k],
      depth + 1,
      path ? `${path}.${k}` : k,
      ctx,
    )
  }
}

function assertArgsShape(value: unknown, depth: number, path: string, ctx: z.RefinementCtx): void {
  if (depth > MAX_ARG_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invoke.args nesting exceeds max depth ${MAX_ARG_DEPTH}`,
      path: argsIssuePath(path),
    })
    return
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') {
    assertArgsString(value, path, ctx)
    return
  }
  if (Array.isArray(value)) {
    assertArgsArray(value, depth, path, ctx)
    return
  }
  if (typeof value === 'object') {
    assertArgsObject(value, depth, path, ctx)
    return
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'invoke.args values must be JSON primitives/objects/arrays',
    path: argsIssuePath(path),
  })
}

const invokeBodySchema = z
  .object({
    tool: toolNameSchema,
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.args !== undefined) {
      assertArgsShape(val.args, 0, 'args', ctx)
    }
  })

const inferBodySchema = z
  .object({
    prompt: z.string().min(1).max(32_000),
    max_tokens: z.number().int().positive().max(100_000).optional(),
    model: z.string().min(1).max(256).optional(),
  })
  .strict()

const approveBodySchema = z
  .object({
    note: z.string().min(1).max(500).optional(),
    timeout_hours: z.number().int().min(1).max(168).optional(),
  })
  .strict()

/** Exactly one of invoke | infer | approve. `agent` rejected under .strict(). */
export const planTaskSchema = z
  .object({
    after: z.array(nonEmptyId).max(MAX_PLAN_TASKS).optional(),
    invoke: invokeBodySchema.optional(),
    infer: inferBodySchema.optional(),
    approve: approveBodySchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const kinds = [val.invoke, val.infer, val.approve].filter((body) => body !== undefined).length
    if (kinds !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task must have exactly one of invoke | infer | approve',
      })
    }
  })

export type PlanTask = z.infer<typeof planTaskSchema>

export const planPermitsSchema = z
  .object({
    tools: z.array(toolNameSchema).max(MAX_PERMIT_TOOLS),
  })
  .strict()

export type PlanPermits = z.infer<typeof planPermitsSchema>

export const planDocumentSchema = z
  .object({
    flows: z.literal(FLOWS_VERSION),
    plan: z
      .object({
        id: nonEmptyId,
        description: z.string().max(2000).optional(),
        model: z.string().min(1).max(256).optional(),
        /** Total static ceiling across all infer tasks (required when any infer). */
        max_tokens: z.number().int().positive().max(MAX_PLAN_TOTAL_TOKENS).optional(),
      })
      .strict(),
    permits: planPermitsSchema,
    tasks: z.record(nonEmptyId, planTaskSchema).superRefine((tasks, ctx) => {
      const n = Object.keys(tasks).length
      if (n < 1 || n > MAX_PLAN_TASKS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `tasks must have 1..${MAX_PLAN_TASKS} entries (got ${n})`,
        })
      }
    }),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const hasInfer = Object.values(doc.tasks).some((t) => t.infer !== undefined)
    if (hasInfer && doc.plan.max_tokens === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan.max_tokens is required when any task uses infer (total ceiling)',
        path: ['plan', 'max_tokens'],
      })
    }
  })

export type PlanDocument = z.infer<typeof planDocumentSchema>

export type SafeParsePlanResult = ReturnType<typeof planDocumentSchema.safeParse>

export function parsePlanDocument(input: unknown): PlanDocument {
  return planDocumentSchema.parse(input)
}

export function safeParsePlanDocument(input: unknown): SafeParsePlanResult {
  return planDocumentSchema.safeParse(input)
}
