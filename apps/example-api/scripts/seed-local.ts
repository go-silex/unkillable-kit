#!/usr/bin/env bun
import { Database, type SQLQueryBindings } from 'bun:sqlite'
/**
 * Local D1 seed for example-api (Wrangler Miniflare state).
 *
 *   bun run db:migrate   # schema only
 *   bun run db:seed      # idempotent users + notes
 *   bun run db:seed -- --reset
 *   bun run db:reset     # migrate + seed --reset
 *
 * Uses bun:sqlite against the local Miniflare D1 file so data is visible to
 * `wrangler dev`. Login hashes are Better Auth scrypt (`seedBaDemoUsers`).
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, type KitD1Database, type KitD1Statement } from '@kit/db'
import { schema } from '../src/db/schema'
import { SEED_NOTES, SEED_USERS } from '../src/seed/demo-data'
import { seedDemoDatabase } from '../src/seed/seed-db'

const __dirname = dirname(fileURLToPath(import.meta.url))
const API_ROOT = join(__dirname, '..')
const MIGRATIONS_DIR = join(API_ROOT, 'migrations')
const D1_DIR = join(API_ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')

const args = new Set(process.argv.slice(2))
const RESET = args.has('--reset')
const JSON_OUT = args.has('--json')

/**
 * D1 accepts any `unknown` bind value; bun:sqlite only takes SQLite scalars.
 * Fail loudly at the boundary instead of handing bun a value it cannot bind.
 */
function toBindings(values: unknown[]): SQLQueryBindings[] {
  return values.map((value, i) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    throw new TypeError(
      `seed-local: bind param ${i} is not a SQLite value (${Object.prototype.toString.call(value)})`,
    )
  })
}

function makeStatement(sqlite: Database, sql: string): KitD1Statement {
  let binds: SQLQueryBindings[] = []
  const stmt: KitD1Statement = {
    bind(...a: unknown[]) {
      binds = toBindings(a)
      return stmt
    },
    // SQLite rows are untyped at runtime; the caller declares the row shape.
    async first<T = unknown>() {
      return (sqlite.prepare(sql).get(...binds) ?? null) as T | null
    },
    async run() {
      const info = sqlite.prepare(sql).run(...binds)
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      }
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...binds), success: true }
    },
    async raw<T = unknown>() {
      const rows = sqlite.prepare(sql).all(...binds) as Record<string, T>[]
      if (rows.length === 0) return []
      const keys = Object.keys(rows[0]!)
      return rows.map((row) => keys.map((k) => row[k]!))
    },
  }
  return stmt
}

function openLocalD1() {
  mkdirSync(D1_DIR, { recursive: true })
  const files = readdirSync(D1_DIR)
    .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    .map((f) => join(D1_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  // Prefer existing wrangler D1 file; otherwise create a stable local seed DB.
  const path = files[0] ?? join(D1_DIR, 'example-api-seed.sqlite')
  const sqlite = new Database(path)
  // Wrangler tracks applied migrations in d1_migrations. Re-running ALTER
  // migrations (e.g. ADD COLUMN) is not idempotent — only apply SQL files when
  // the DB was not already migrated by `wrangler d1 migrations apply --local`.
  const alreadyMigrated = Boolean(
    sqlite
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations' LIMIT 1",
      )
      .get(),
  )
  if (!alreadyMigrated) {
    for (const name of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
    }
  }
  const d1: KitD1Database = {
    prepare(sql: string) {
      return makeStatement(sqlite, sql)
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      return Promise.all(stmts.map((s) => s.run()))
    },
    async exec(sql: string) {
      sqlite.exec(sql)
      return [{ success: true }]
    },
  }
  return { sqlite, d1, path }
}

async function main() {
  const { d1, path, sqlite } = openLocalD1()
  try {
    const db = createDb(d1, schema)
    const result = await seedDemoDatabase(db, { reset: RESET, environment: 'development' })

    if (JSON_OUT) {
      console.log(JSON.stringify({ ok: true, db: path, ...result }, null, 2))
      return
    }

    console.log(`D1 local: ${path}`)
    console.log(RESET ? 'Mode: RESET + seed' : 'Mode: idempotent seed')
    console.log('')
    console.log('Users:')
    for (const u of result.users) {
      const plain = SEED_USERS.find((s) => s.id === u.id)
      const flag = u.created ? '+ created' : '= exists'
      console.log(`  ${flag}  ${u.email}  (${u.role})  id=${u.id}`)
      if (plain) console.log(`           password: ${plain.password}`)
    }
    console.log('')
    console.log('Notes:')
    for (const n of result.notes) {
      const flag = n.created ? '+ created' : '= exists'
      console.log(`  ${flag}  [${n.subject}] ${n.title}  (${n.id})`)
    }
    console.log('')
    console.log(`Seed notes defined: ${SEED_NOTES.length}`)
    console.log('')
    console.log('Modules (platform_modules):')
    for (const mod of result.modules) {
      const flag = mod.created ? '+ created' : '= exists'
      console.log(`  ${flag}  ${mod.id}  enabled=${mod.enabled}  configured=${mod.configured}`)
    }
    console.log('')
    console.log('Next: cd apps/example-api && bun run dev')
  } finally {
    sqlite.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
