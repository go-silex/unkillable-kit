import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migDir = join(__dirname, '../migrations')
const files = readdirSync(migDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
const oidcFreshLoginMigration = '0028_better_auth_oidc_fresh_login.sql'

function applyThrough(sqlite: Database.Database, last: string): void {
  for (const name of files) {
    if (name > last) break
    sqlite.exec(readFileSync(join(migDir, name), 'utf8'))
  }
}

function applyMigration(sqlite: Database.Database, name: string): void {
  sqlite.exec(readFileSync(join(migDir, name), 'utf8'))
}

function insertLegacyAccount(
  sqlite: Database.Database,
  input: { accountId?: string; providerId?: string } = {},
): void {
  const accountId = input.accountId ?? 'user_1'
  const providerId = input.providerId ?? 'credential'
  sqlite
    .prepare(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('user_1', 'User', 'user@example.com', 1, 1, 1)`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO account (
         id, account_id, provider_id, user_id, password, created_at, updated_at
       ) VALUES ('account_1', ?, ?, 'user_1', 'hash', 1, 1)`,
    )
    .run(accountId, providerId)
}

describe('D1 migrations', () => {
  it('applies the complete sequence on a greenfield database', () => {
    const sqlite = new Database(':memory:')
    expect(files).toContain('0001_init.sql')
    expect(files).toContain('0002_api_keys_prefix.sql')
    expect(files).toContain('0014_better_auth_1_7_additive.sql')
    expect(files).toContain('0015_api_keys_org_not_null.sql')
    expect(files).toContain(oidcFreshLoginMigration)
    applyThrough(sqlite, files.at(-1)!)
    const cols = sqlite.prepare(`PRAGMA table_info(api_keys)`).all() as {
      name: string
      notnull: number
    }[]
    const names = cols.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'key_hash',
        'key_prefix',
        'name',
        'expires_at',
        'revoked_at',
        'organization_id',
      ]),
    )
    expect(cols.find((c) => c.name === 'organization_id')?.notnull).toBe(1)
    const accountCols = sqlite.prepare(`PRAGMA table_info(account)`).all() as {
      name: string
      notnull: number
      dflt_value: string | null
    }[]
    expect(accountCols).toContainEqual(
      expect.objectContaining({
        name: 'issuer',
        notnull: 1,
        dflt_value: "'local:credential'",
      }),
    )
    const accountIndexes = sqlite.prepare(`PRAGMA index_list(account)`).all() as {
      name: string
      unique: number
    }[]
    expect(accountIndexes).toContainEqual(
      expect.objectContaining({ name: 'account_issuer_accountId_uidx', unique: 1 }),
    )
    expect(
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .pluck()
        .get('oidc_session_authentication'),
    ).toBe('oidc_session_authentication')
    sqlite.close()
  })

  it('adds OIDC password evidence without backfilling existing sessions and cascades deletion', () => {
    const sqlite = new Database(':memory:')
    try {
      sqlite.pragma('foreign_keys = ON')
      applyThrough(sqlite, '0027_better_auth_oidc_provider.sql')
      insertLegacyAccount(sqlite)
      sqlite
        .prepare(
          `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
           VALUES ('session_1', 2000, 'token_1', 1000, 1000, 'user_1')`,
        )
        .run()

      applyMigration(sqlite, oidcFreshLoginMigration)
      expect(sqlite.prepare('SELECT id FROM session').pluck().all()).toEqual(['session_1'])
      expect(sqlite.prepare('SELECT * FROM oidc_session_authentication').all()).toEqual([])

      const insert = sqlite.prepare(
        `INSERT INTO oidc_session_authentication (session_id, method, authenticated_at)
         VALUES (?, ?, ?)`,
      )
      expect(() => insert.run('session_1', 'magic-link', 1000)).toThrow(/CHECK constraint failed/)
      expect(() => insert.run('session_1', 'password', 0)).toThrow(/CHECK constraint failed/)
      expect(() => insert.run('session_1', 'password', 1000.5)).toThrow(/CHECK constraint failed/)
      expect(() => insert.run('missing', 'password', 1000)).toThrow(/FOREIGN KEY constraint failed/)
      expect(insert.run('session_1', 'password', 1000).changes).toBe(1)
      expect(() => insert.run('session_1', 'password', 1000)).toThrow(/UNIQUE constraint failed/)

      sqlite.prepare('DELETE FROM session WHERE id = ?').run('session_1')
      expect(sqlite.prepare('SELECT * FROM oidc_session_authentication').all()).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('adds credential identity without replacing account and remains compatible with 1.6 inserts', () => {
    const sqlite = new Database(':memory:')
    applyThrough(sqlite, '0013_tasks_comments.sql')
    insertLegacyAccount(sqlite)
    const rootPageBefore = sqlite
      .prepare(`SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'account'`)
      .pluck()
      .get()

    applyMigration(sqlite, '0014_better_auth_1_7_additive.sql')

    const rootPageAfter = sqlite
      .prepare(`SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'account'`)
      .pluck()
      .get()
    expect(rootPageAfter).toBe(rootPageBefore)
    const account = sqlite
      .prepare(`SELECT issuer, account_id AS accountId FROM account WHERE id = 'account_1'`)
      .get()
    expect(account).toEqual({ issuer: 'local:credential', accountId: 'user_1' })
    sqlite
      .prepare(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ('user_2', 'Legacy Worker', 'legacy@example.com', 1, 1, 1)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO account (
           id, account_id, provider_id, user_id, password, created_at, updated_at
         ) VALUES ('account_2', 'user_2', 'credential', 'user_2', 'hash', 1, 1)`,
      )
      .run()
    expect(sqlite.prepare(`SELECT issuer FROM account WHERE id = 'account_2'`).pluck().get()).toBe(
      'local:credential',
    )
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO account (
             id, account_id, provider_id, issuer, user_id, created_at, updated_at
           ) VALUES (
             'account_3', 'user_1', 'credential', 'local:credential', 'user_1', 1, 1
           )`,
        )
        .run(),
    ).toThrow(/UNIQUE/)
    sqlite.close()
  })

  it('rejects identity collisions before changing the legacy account table', () => {
    const sqlite = new Database(':memory:')
    applyThrough(sqlite, '0013_tasks_comments.sql')
    insertLegacyAccount(sqlite)
    sqlite
      .prepare(
        `INSERT INTO account (
           id, account_id, provider_id, user_id, password, created_at, updated_at
         ) VALUES ('account_2', 'user_1', 'credential', 'user_1', 'hash', 1, 1)`,
      )
      .run()

    expect(() => applyMigration(sqlite, '0014_better_auth_1_7_additive.sql')).toThrow(/NOT NULL/)

    const accountCols = sqlite.prepare(`PRAGMA table_info(account)`).all() as { name: string }[]
    expect(accountCols.map((column) => column.name)).not.toContain('issuer')
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM account`).get()).toEqual({ count: 2 })
    sqlite.close()
  })

  it('fails closed instead of guessing an issuer for an unexpected provider', () => {
    const sqlite = new Database(':memory:')
    applyThrough(sqlite, '0013_tasks_comments.sql')
    insertLegacyAccount(sqlite, { providerId: 'github' })

    expect(() => applyMigration(sqlite, '0014_better_auth_1_7_additive.sql')).toThrow(/NOT NULL/)
    const accountCols = sqlite.prepare(`PRAGMA table_info(account)`).all() as { name: string }[]
    expect(accountCols.map((column) => column.name)).not.toContain('issuer')
    sqlite.close()
  })
})
