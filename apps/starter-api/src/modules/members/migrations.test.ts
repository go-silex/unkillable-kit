import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'

const directory = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const scopeMigration = '0013_kit_api_keys_scopes.sql'

function database() {
  const sqlite = new Database(':memory:')
  onTestFinished(() => sqlite.close())
  return sqlite
}

function migrate(sqlite: Database.Database, files: string[]) {
  for (const file of files) sqlite.exec(readFileSync(`${directory}/${file}`, 'utf8'))
}

const migrations = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const insertKey = `INSERT INTO api_keys (id, key_hash, key_prefix, subject, organization_id, created_at)
  VALUES (?, ?, ?, 'user', 'org', 1)`

describe('starter API key scopes migration', () => {
  it('creates a fresh schema where new keys have no implicit scopes', () => {
    const sqlite = database()
    migrate(sqlite, migrations)
    sqlite.prepare(insertKey).run('fresh', 'hash', 'prefix')
    expect(sqlite.prepare('SELECT scopes FROM api_keys WHERE id = ?').get('fresh')).toEqual({
      scopes: '',
    })
  })

  it('backfills legacy keys and leaves subsequently inserted keys unscoped', () => {
    const sqlite = database()
    migrate(
      sqlite,
      migrations.filter((file) => file < scopeMigration),
    )
    sqlite.prepare(insertKey).run('legacy', 'legacy-hash', 'legacy-prefix')
    migrate(sqlite, [scopeMigration])
    sqlite.prepare(insertKey).run('new', 'new-hash', 'new-prefix')
    expect(sqlite.prepare('SELECT scopes FROM api_keys WHERE id = ?').get('legacy')).toEqual({
      scopes: 'read,write,admin',
    })
    expect(sqlite.prepare('SELECT scopes FROM api_keys WHERE id = ?').get('new')).toEqual({
      scopes: '',
    })
  })
})
