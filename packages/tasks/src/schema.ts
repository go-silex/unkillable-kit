import * as z from 'zod'
import {
  MAX_ASSIGNEES,
  MAX_BOARD_KEY_LEN,
  MAX_SCOPE_ID_LEN,
  MAX_SCOPE_KIND_LEN,
  MAX_STAGE_LABEL_LEN,
  MAX_TASK_DESCRIPTION_LEN,
  MAX_TASK_TITLE_LEN,
  TASK_LINK_KINDS,
  TASK_PRIORITIES,
  TASK_VISIBILITIES,
} from './constants'

const idSchema = z.string().min(1).max(256)
const boardKeySchema = z
  .string()
  .min(1)
  .max(MAX_BOARD_KEY_LEN)
  .regex(/^[a-z][a-z0-9_-]*$/, 'board_key must be lowercase slug')

const scopeKindSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_KIND_LEN)
  .regex(/^[a-z][a-z0-9_]*$/, 'scope_kind must be lowercase snake/slug')

const optionalUrl = z
  .union([z.string().url(), z.literal('')])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))

function refineScopePair(
  value: { scopeKind?: string | null; scopeId?: string | null },
  ctx: z.RefinementCtx,
) {
  const hasKind = value.scopeKind != null && value.scopeKind !== ''
  const hasId = value.scopeId != null && value.scopeId !== ''
  if (hasKind !== hasId) {
    ctx.addIssue({
      code: 'custom',
      message: 'scopeKind and scopeId must both be set or both null',
      path: hasKind ? ['scopeId'] : ['scopeKind'],
    })
  }
}

/** Stage row (kanban column) — product seeds labels; kit owns position/terminal rules. */
export const taskStageSchema = z
  .object({
    id: idSchema,
    orgId: idSchema,
    boardKey: boardKeySchema,
    label: z.string().min(1).max(MAX_STAGE_LABEL_LEN),
    position: z.number().int().min(0).max(10_000),
    isDefault: z.boolean(),
    isTerminal: z.boolean(),
  })
  .strict()

export type TaskStage = z.infer<typeof taskStageSchema>

/** Core task record (durable shape apps persist). */
export const taskSchema = z
  .object({
    id: idSchema,
    orgId: idSchema,
    title: z.string().min(1).max(MAX_TASK_TITLE_LEN),
    description: z.string().max(MAX_TASK_DESCRIPTION_LEN).nullable().optional(),
    boardKey: boardKeySchema,
    stageId: idSchema,
    visibility: z.enum(TASK_VISIBILITIES),
    /** Opaque product scope (e.g. project, client). Both null = org-global. */
    scopeKind: scopeKindSchema.nullable().optional(),
    scopeId: z.string().min(1).max(MAX_SCOPE_ID_LEN).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    dueAt: z.number().int().nonnegative().nullable().optional(),
    done: z.boolean(),
    order: z.number().int().min(0).max(1_000_000).optional(),
    externalUrl: optionalUrl.nullable().optional(),
    createdBy: idSchema,
    assigneeIds: z.array(idSchema).max(MAX_ASSIGNEES).default([]),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine(refineScopePair)

export type Task = z.infer<typeof taskSchema>

export const createTaskInputSchema = z
  .object({
    orgId: idSchema,
    title: z.string().min(1).max(MAX_TASK_TITLE_LEN),
    description: z.string().max(MAX_TASK_DESCRIPTION_LEN).optional(),
    boardKey: boardKeySchema,
    /** Omit → app resolves default stage for board. */
    stageId: idSchema.optional(),
    visibility: z.enum(TASK_VISIBILITIES).optional().default('shared'),
    scopeKind: scopeKindSchema.nullable().optional(),
    scopeId: z.string().min(1).max(MAX_SCOPE_ID_LEN).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    dueAt: z.number().int().nonnegative().nullable().optional(),
    done: z.boolean().optional().default(false),
    order: z.number().int().min(0).max(1_000_000).optional(),
    externalUrl: optionalUrl.optional(),
    createdBy: idSchema,
    assigneeIds: z.array(idSchema).max(MAX_ASSIGNEES).optional().default([]),
  })
  .strict()
  .superRefine(refineScopePair)

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>

export const updateTaskInputSchema = z
  .object({
    title: z.string().min(1).max(MAX_TASK_TITLE_LEN).optional(),
    description: z.string().max(MAX_TASK_DESCRIPTION_LEN).nullable().optional(),
    boardKey: boardKeySchema.optional(),
    stageId: idSchema.optional(),
    visibility: z.enum(TASK_VISIBILITIES).optional(),
    scopeKind: scopeKindSchema.nullable().optional(),
    scopeId: z.string().min(1).max(MAX_SCOPE_ID_LEN).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    dueAt: z.number().int().nonnegative().nullable().optional(),
    done: z.boolean().optional(),
    order: z.number().int().min(0).max(1_000_000).optional(),
    externalUrl: optionalUrl.nullable().optional(),
    assigneeIds: z.array(idSchema).max(MAX_ASSIGNEES).optional(),
  })
  .strict()
  .superRefine(refineScopePair)

export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>

export const taskLinkSchema = z
  .object({
    id: idSchema,
    orgId: idSchema,
    fromTaskId: idSchema,
    toTaskId: idSchema,
    kind: z.enum(TASK_LINK_KINDS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fromTaskId === value.toTaskId) {
      ctx.addIssue({
        code: 'custom',
        message: 'task link cannot be reflexive',
        path: ['toTaskId'],
      })
    }
  })

export type TaskLink = z.infer<typeof taskLinkSchema>

export const createTaskLinkInputSchema = z
  .object({
    orgId: idSchema,
    fromTaskId: idSchema,
    toTaskId: idSchema,
    kind: z.enum(TASK_LINK_KINDS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fromTaskId === value.toTaskId) {
      ctx.addIssue({
        code: 'custom',
        message: 'task link cannot be reflexive',
        path: ['toTaskId'],
      })
    }
  })

export type CreateTaskLinkInput = z.infer<typeof createTaskLinkInputSchema>

export function parseTask(input: unknown) {
  return taskSchema.safeParse(input)
}

export function parseCreateTaskInput(input: unknown) {
  return createTaskInputSchema.safeParse(input)
}

export function parseUpdateTaskInput(input: unknown) {
  return updateTaskInputSchema.safeParse(input)
}

export function parseTaskStage(input: unknown) {
  return taskStageSchema.safeParse(input)
}

export function parseTaskLink(input: unknown) {
  return taskLinkSchema.safeParse(input)
}

export function parseCreateTaskLinkInput(input: unknown) {
  return createTaskLinkInputSchema.safeParse(input)
}
