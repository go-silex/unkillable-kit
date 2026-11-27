import type { ChannelResult } from '@kit/notifications'
import * as z from 'zod'

export const deliveryCodeSchema = z
  .string()
  .min(1)
  .max(128)
  // Absolute end: JavaScript's $ also accepts a final newline.
  .regex(/^[a-z][a-z0-9_]*(?![\s\S])/)

export const deliveryOutcomeSchema = z.strictObject({
  status: z.enum(['sent', 'failed', 'skipped']),
  code: deliveryCodeSchema.nullable(),
})

export type DeliveryOutcome = Readonly<z.infer<typeof deliveryOutcomeSchema>>
export type DeliveryAttemptResult =
  | DeliveryOutcome
  | Extract<ChannelResult, { status: 'retryable' }>
