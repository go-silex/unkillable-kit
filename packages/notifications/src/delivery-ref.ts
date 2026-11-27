import * as z from 'zod'

// Absolute end keeps the full-string ASCII rule declarative for schema consumers.
export const notificationRowIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/)

export const deliveryRefSchema = z.strictObject({
  orgId: z.string().min(1).max(256),
  kind: z.enum(['user', 'organization']),
  id: notificationRowIdSchema,
})

export type DeliveryRef = Readonly<z.infer<typeof deliveryRefSchema>>
