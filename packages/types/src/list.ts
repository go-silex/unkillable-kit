import * as z from 'zod'

/** Shared list query — apps may `.extend` (e.g. `q` max). Limit default applied via `clampListLimit`. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
  q: z.string().optional(),
})

export type ListQuery = z.infer<typeof listQuerySchema>

/** Success page body. Wire routes add `requestId` separately. */
export type ListPage<T> = {
  items: T[]
  nextCursor: string | null
}
