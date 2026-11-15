import type { KitD1Database, KitD1Statement } from '@kit/db'
import type { Db } from './types'

type BatchResult = { results: Record<string, unknown>[] }

export function binding(db: Db): KitD1Database {
  // Drizzle exposes $client at runtime, but its public base database type omits it.
  const withClient = db as Db & { $client: KitD1Database }
  return withClient.$client
}

/** Execute all statements in one D1 transaction, preserving RETURNING rows. */
export async function lifecycleBatch(db: Db, statements: KitD1Statement[]): Promise<BatchResult[]> {
  if (statements.length === 0) return []
  const client = binding(db)
  if (!client.batch) throw new Error('D1 batch is required')
  return (await client.batch(statements)) as BatchResult[]
}

export function lifecycleStatement(db: Db, sql: string, values: unknown[]): KitD1Statement {
  const client = binding(db)
  return client.prepare(sql).bind(...values)
}
