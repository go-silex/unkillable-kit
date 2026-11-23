import type Database from 'better-sqlite3'
import type { KitD1Database, KitD1Statement } from '../index'
import { callSqlite } from '../sqlite-error'

export { countD1RoundTrips } from './d1-round-trips'

export type SqliteD1Options = {
  onBind?: (parameterCount: number) => void
}

type StatementPlan = {
  sql: string
  values: readonly unknown[]
}

type SqliteD1Result = {
  success: true
  results: []
  meta: { changes: number; last_row_id: number }
}

type SqliteD1Rows = {
  success: true
  results: unknown[]
}

/** D1-shaped binding backed by a caller-owned SQLite handle. */
export type SqliteD1 = Required<KitD1Database>

/**
 * Adapts a caller-owned better-sqlite3 handle to the D1 surface used by Drizzle tests.
 * Schema, migrations, foreign-key mode, and lifetime remain the caller's responsibility.
 */
export function createSqliteD1(sqlite: Database.Database, options: SqliteD1Options = {}): SqliteD1 {
  const plans = new WeakMap<object, StatementPlan>()

  function execute(plan: StatementPlan): SqliteD1Result | SqliteD1Rows {
    const statement = sqlite.prepare(plan.sql)
    if (statement.reader) {
      return { results: statement.all(...plan.values), success: true }
    }

    const info = statement.run(...plan.values)
    return {
      success: true,
      results: [],
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
    }
  }

  function prepare(sql: string, values: readonly unknown[] = []): KitD1Statement {
    const statement: KitD1Statement = {
      bind(...nextValues: unknown[]) {
        options.onBind?.(nextValues.length)
        return prepare(sql, nextValues)
      },
      async first<T = unknown>() {
        return callSqlite(() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null)
      },
      async run() {
        return callSqlite(() => execute({ sql, values }))
      },
      async all() {
        return callSqlite(() => execute({ sql, values }))
      },
      async raw<T = unknown>() {
        return callSqlite(
          () =>
            sqlite
              .prepare(sql)
              .raw(true)
              .all(...values) as T[][],
        )
      },
    }
    plans.set(statement, { sql, values })
    return statement
  }

  return {
    prepare,
    async batch(statements: unknown[]) {
      return callSqlite(() => {
        const batchPlans = statements.map((statement) => {
          if (typeof statement !== 'object' || statement === null) {
            throw new Error('D1 batch accepts prepared statements')
          }
          const plan = plans.get(statement)
          if (!plan) throw new Error('D1 batch statement belongs to another database')
          return plan
        })
        return sqlite.transaction((items: StatementPlan[]) => items.map(execute))(batchPlans)
      })
    },
    async exec(query: string) {
      return callSqlite(() => {
        sqlite.exec(query)
        return { count: 1, duration: 0 }
      })
    },
  }
}
