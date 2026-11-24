import { readFileSync } from 'node:fs'
import { createSqliteD1, type SqliteD1 } from '@kit/db/testing'
import Database from 'better-sqlite3'
import { onTestFinished } from 'vitest'

type AuthFixture = {
  db: SqliteD1
  sqlite: {
    exec(sql: string): void
    prepare(sql: string): { run(...values: unknown[]): void }
  }
}

export function createAuthFixture(...users: string[]): AuthFixture {
  const sqlite = new Database(':memory:')
  onTestFinished(() => {
    sqlite.close()
  })
  for (const migration of [
    '0003_kit_modules.sql',
    '0004_kit_modules_config.sql',
    '0005_better_auth.sql',
    '0006_better_auth_organization.sql',
    '0007_rbac_modules.sql',
    '0009_organization_roles_grants.sql',
    '0025_account_state.sql',
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../../../../apps/example-api/migrations/${migration}`, import.meta.url),
        'utf8',
      ),
    )
  }
  const insert = sqlite.prepare(
    'INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
  )
  for (const user of users) insert.run(user, user, `${user}@example.test`)
  return { db: createSqliteD1(sqlite), sqlite }
}
