import { countD1RoundTrips, type SqliteD1 } from '@kit/db/testing'

export const CAUSE = 'private_sql_or_decoder_cause'
export type Statement = { sql: string; values: unknown[] }
export type DriverFailure = 'throw' | 'partial' | 'malformed'

export function observeOrganizationDb(db: SqliteD1) {
  const plans = new WeakMap<object, Statement>()
  const batches: Statement[][] = []
  let driverFailure: DriverFailure | undefined
  const budget = countD1RoundTrips({
    ...db,
    prepare(sql: string) {
      const statement = db.prepare(sql)
      return {
        ...statement,
        bind(...values: unknown[]) {
          const bound = statement.bind(...values)
          plans.set(bound, { sql, values })
          return bound
        },
      }
    },
    async batch(statements: unknown[]) {
      const captured = statements.map((stmt) => plans.get(stmt as object)!)
      batches.push(captured)
      const index = captured.findIndex(
        ({ sql }) => sql.includes('AS fact') && sql.includes('product_business'),
      )
      if (index >= 0 && driverFailure === 'throw') throw new Error(CAUSE)
      const result = await db.batch(statements)
      if (index >= 0 && Array.isArray(result)) {
        if (driverFailure === 'partial') return result.slice(0, -1)
        if (driverFailure === 'malformed')
          result[index] = { success: true, results: [{ label: {} }] }
      }
      return result
    },
  })
  return {
    budget,
    batches,
    setDriverFailure(value?: DriverFailure) {
      driverFailure = value
    },
  }
}
