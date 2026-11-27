import type { WorkflowDelayFunction } from 'cloudflare:workers'
import * as z from 'zod'
import { deliveryCodeSchema } from './types'

const retryableName = 'NotificationDeliveryRetryable'
const rpcPrefix = `${retryableName}: `
const retryableSchema = z.strictObject({
  code: deliveryCodeSchema,
  retryAfterSeconds: z.number().finite().nonnegative().max(86_400).optional(),
})

type RetryablePayload = z.input<typeof retryableSchema>

export function createDeliveryRetryableError(payload: RetryablePayload): Error {
  const validated = retryableSchema.parse(payload)
  const error = new Error(JSON.stringify(validated))
  error.name = retryableName
  return error
}

function retryHint(error: Error): number | undefined {
  let message: string
  if (error.name === retryableName) {
    message = error.message
  } else if (error.name === 'Error' && error.message.startsWith(rpcPrefix)) {
    message = error.message.slice(rpcPrefix.length)
  } else {
    // A malformed private envelope cannot safely be treated as a hintless interruption.
    if (error.name.includes(retryableName) || error.message.includes(retryableName)) {
      throw new Error('Invalid notification delivery retry envelope')
    }
    return undefined
  }

  try {
    return retryableSchema.parse(JSON.parse(message)).retryAfterSeconds
  } catch {
    throw new Error('Invalid notification delivery retry envelope')
  }
}

export const notificationDeliveryRetryDelay: WorkflowDelayFunction = ({ ctx, error }) => {
  const hint = retryHint(error)
  const base = Math.min(86_400, 60 * 2 ** Math.min(11, Math.max(0, ctx.attempt - 1)))
  return 1_000 * Math.min(86_400, Math.max(base, Math.ceil(hint ?? 0)))
}
