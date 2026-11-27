import * as z from 'zod'
import { COMMENT_VISIBILITIES, MAX_COMMENT_BODY_LEN, MAX_TARGET_TYPE_LEN } from './constants'

const idSchema = z.string().min(1).max(256)

const targetTypeSchema = z
  .string()
  .min(1)
  .max(MAX_TARGET_TYPE_LEN)
  .regex(/^[a-z][a-z0-9_]*$/, 'target_type must be lowercase snake')

export const commentTargetSchema = z
  .object({
    targetType: targetTypeSchema,
    targetId: idSchema,
  })
  .strict()

export type CommentTarget = z.infer<typeof commentTargetSchema>

export const commentSchema = z
  .object({
    id: idSchema,
    orgId: idSchema,
    targetType: targetTypeSchema,
    targetId: idSchema,
    authorId: idSchema,
    body: z.string().min(1).max(MAX_COMMENT_BODY_LEN),
    visibility: z.enum(COMMENT_VISIBILITIES),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict()

export type Comment = z.infer<typeof commentSchema>

export const createCommentInputSchema = z
  .object({
    orgId: idSchema,
    targetType: targetTypeSchema,
    targetId: idSchema,
    authorId: idSchema,
    body: z.string().min(1).max(MAX_COMMENT_BODY_LEN),
    visibility: z.enum(COMMENT_VISIBILITIES).optional().default('shared'),
  })
  .strict()

export type CreateCommentInput = z.infer<typeof createCommentInputSchema>

export const updateCommentInputSchema = z
  .object({
    body: z.string().min(1).max(MAX_COMMENT_BODY_LEN).optional(),
    visibility: z.enum(COMMENT_VISIBILITIES).optional(),
  })
  .strict()

export type UpdateCommentInput = z.infer<typeof updateCommentInputSchema>

export function parseComment(input: unknown) {
  return commentSchema.safeParse(input)
}

export function parseCreateCommentInput(input: unknown) {
  return createCommentInputSchema.safeParse(input)
}

export function parseUpdateCommentInput(input: unknown) {
  return updateCommentInputSchema.safeParse(input)
}

export function parseCommentTarget(input: unknown) {
  return commentTargetSchema.safeParse(input)
}
