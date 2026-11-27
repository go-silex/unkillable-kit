import * as z from 'zod'
import { WHOAMI_STATUS, type WhoamiStatus } from './agentWire'

const whoamiStatusTuple = WHOAMI_STATUS as unknown as [WhoamiStatus, ...WhoamiStatus[]]

/** Kit ping tool result. */
export const pingResultSchema = z.object({
  ok: z.literal(true),
})

export type PingResult = z.infer<typeof pingResultSchema>

/**
 * Parse subset for GET /api/me used by whoami — **not** full HTTP API SSoT.
 * Requires non-empty subject string.
 */
export const meResponseSchema = z.object({
  subject: z.string().min(1),
  authMethod: z.string().optional(),
  requestId: z.string().optional(),
})

export type MeResponse = z.infer<typeof meResponseSchema>

/** Whoami tool JSON result (domain channel). */
export const whoamiResultSchema = z.object({
  keyPresent: z.boolean(),
  verified: z.boolean(),
  subject: z.string().nullable(),
  status: z.enum(whoamiStatusTuple),
  /** Hosted MCP identity (absent on stdio sk_ path). */
  userId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
})

export type WhoamiResultParsed = z.infer<typeof whoamiResultSchema>
