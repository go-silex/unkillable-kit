import * as z from 'zod'
import { deliveryRefSchema } from '../delivery-ref'
import { epochMsSchema, identitySchema, rowIdSchema, workflowIdSchema } from './validation'

const prefixed = (value: { kind: 'user' | 'organization'; id: string }) =>
  value.id.startsWith(value.kind === 'user' ? 'u_' : 'o_')

export const observationInputSchema = z.strictObject({
  ref: deliveryRefSchema.refine(
    (value) => prefixed(value) && /^[A-Za-z0-9]/.test(value.id.slice(2)),
  ),
  workflowId: workflowIdSchema,
  observedAt: epochMsSchema,
  observation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('admitted'), proof: z.enum(['created', 'instance_present']) }),
    z.strictObject({ kind: z.literal('unknown') }),
    z.strictObject({ kind: z.literal('expired') }),
  ]),
})
export const scopeSchema = z.strictObject({ orgId: identitySchema })
export const candidatesQuerySchema = z.strictObject({
  now: epochMsSchema,
  limit: z.number().int().min(1).max(100),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
})
export const keysetSchema = z
  .strictObject({
    asOf: epochMsSchema,
    lastCheckAt: z.union([z.literal(-1), epochMsSchema]),
    createdAt: epochMsSchema,
    kind: z.enum(['user', 'organization']),
    id: rowIdSchema,
  })
  .refine(prefixed)
