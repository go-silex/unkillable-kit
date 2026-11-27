import { AppError } from '@kit/core'
import * as z from 'zod'
import { notificationRowIdSchema } from '../delivery-ref'
import { parseNotificationParams } from '../params'
import type { Json } from '../types'
import { validKey } from '../validation'

export const rowIdSchema = notificationRowIdSchema
export const identitySchema = z.string().min(1).max(256)
export const epochMsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const typeKeySchema = z.string().refine((value) => validKey(value, 128))
export const channelKeySchema = z
  .string()
  .refine((value) => value !== 'in_app' && validKey(value, 64))
export const sourceRefSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  id: z.string().min(1).max(1024),
})
export const selectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('type'), value: typeKeySchema }),
  z.strictObject({ kind: z.literal('category'), value: typeKeySchema }),
])
export const workflowIdSchema = z
  .string()
  .length(70)
  .regex(/^nd-v1-[a-f0-9]{64}$/)
export const listQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
})

const jsonParamsType = { params: z.json() }

export function parseRepositoryInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw AppError.validation('Invalid notifications input')
  return parsed.data
}

export function serializeParams(value: Json): string {
  try {
    return JSON.stringify(parseNotificationParams(jsonParamsType, value))
  } catch {
    throw AppError.validation('Invalid notification parameters')
  }
}
