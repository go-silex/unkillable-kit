import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countD1RoundTrips, createSqliteD1 } from './test/sqlite-d1'

const MODULES_ROOT = dirname(fileURLToPath(import.meta.url))
// Fixed at the repository Worker baseline; this local binding contract does not assert deploy config.
const MINIFLARE_COMPATIBILITY_DATE = '2026-07-01'

type D1Result<T = unknown> = {
  success: boolean
  results: T[]
  meta?: { changes: number; last_row_id: number }
}

type Statement = {
  bind(...values: unknown[]): Statement
  first<T = unknown>(): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
  raw<T = unknown>(): Promise<T[][]>
}

type D1 = {
  prepare(sql: string): Statement
  batch(statements: Statement[]): Promise<D1Result[]>
  exec(query: string): Promise<{ count: number; duration: number }>
  withSession?(constraint: 'first-primary'): Pick<D1, 'prepare' | 'batch'>
}

type Fixture = {
  d1: D1
  dispose(): Promise<void>
}

type Backend = {
  name: string
  create(): Promise<Fixture>
}

const backends: Backend[] = [
  {
    name: 'SQLite adapter',
    async create() {
      const sqlite = new Database(':memory:')
      return {
        d1: createSqliteD1(sqlite) as unknown as D1,
        async dispose() {
          sqlite.close()
        },
      }
    },
  },
  {
    name: 'local workerd D1',
    async create() {
      const miniflare = new Miniflare({
        workers: [
          {
            config: {
              name: 'sqlite-d1-contract',
              compatibilityDate: MINIFLARE_COMPATIBILITY_DATE,
              env: {
                DB: {
                  type: 'd1',
                  name: 'sqlite-d1-contract',
                  id: '00000000-0000-0000-0000-000000000001',
                },
              },
              manifest: {
                mainModule: 'worker.mjs',
                modulesRoot: MODULES_ROOT,
                modules: {
                  'worker.mjs': {
                    type: 'esm',
                    contents: "export default { fetch() { return new Response('ok') } }",
                  },
                },
              },
            },
          },
        ],
      })
      try {
        return {
          d1: (await miniflare.getD1Database('DB')) as unknown as D1,
          async dispose() {
            await miniflare.dispose()
          },
        }
      } catch (error) {
        await miniflare.dispose()
        throw error
      }
    },
  },
]

for (const backend of backends) {
  describe(`createSqliteD1 D1 contract: ${backend.name}`, () => {
    let fixture!: Fixture
    let cleanup: Fixture | undefined

    beforeEach(async () => {
      fixture = await backend.create()
      cleanup = fixture
      await fixture.d1.exec(
        'CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL)',
      )
    })

    afterEach(async () => {
      const current = cleanup
      cleanup = undefined
      if (current) await current.dispose()
    })

    it('counts executions, not statement construction or the statements inside a batch', async () => {
      const measured = countD1RoundTrips(fixture.d1)
      const insert = measured.db.prepare('INSERT INTO entries (value) VALUES (?)')
      const insertions = [insert.bind('first'), insert.bind('second')]
      expect(measured.count).toBe(0)
      await measured.db.batch(insertions)
      expect(measured.count).toBe(1)

      const select = measured.db.prepare('SELECT value FROM entries ORDER BY id')
      expect(await select.first()).toEqual({ value: 'first' })
      expect(measured.count).toBe(2)
      await select.all()
      expect(measured.count).toBe(3)
      expect(await select.raw()).toEqual([['first'], ['second']])
      expect(measured.count).toBe(4)
      await insert.bind('third').run()
      expect(measured.count).toBe(5)
      await measured.db.exec("INSERT INTO entries (value) VALUES ('fourth')")
      expect(measured.count).toBe(6)
    })

    if (backend.name === 'local workerd D1') {
      it('includes D1 Session calls in the same request count', async () => {
        const measured = countD1RoundTrips(fixture.d1)
        const session = measured.db.withSession!('first-primary')
        const query = session.prepare('SELECT 1 AS value')
        expect(measured.count).toBe(0)
        await session.batch([query, query])
        expect(await query.first()).toEqual({ value: 1 })
        expect(measured.count).toBe(2)
        await fixture.d1.prepare('SELECT 1').first()
        expect(measured.count).toBe(2)
      })
    }

    it('keeps each bound statement value independent in a batch', async () => {
      const insert = fixture.d1.prepare('INSERT INTO entries (value) VALUES (?)')

      await fixture.d1.batch([insert.bind('first'), insert.bind('second')])

      expect(
        await fixture.d1.prepare('SELECT value FROM entries ORDER BY id').raw<string>(),
      ).toEqual([['first'], ['second']])
    })

    it('executes writes through run, all, and batch with empty result rows', async () => {
      const results = [
        await fixture.d1.prepare("INSERT INTO entries (value) VALUES ('from-run')").run(),
        await fixture.d1.prepare("INSERT INTO entries (value) VALUES ('from-all')").all(),
        ...(await fixture.d1.batch([
          fixture.d1.prepare("INSERT INTO entries (value) VALUES ('first')"),
          fixture.d1.prepare("INSERT INTO entries (value) VALUES ('second')"),
        ])),
      ]

      expect(results).toHaveLength(4)
      for (const result of results) {
        expect(result).toMatchObject({ success: true, results: [], meta: { changes: 1 } })
      }
      expect(
        await fixture.d1.prepare('SELECT value FROM entries ORDER BY id').raw<string>(),
      ).toEqual([['from-run'], ['from-all'], ['first'], ['second']])
    })

    it('rolls back every write when a later batch statement fails', async () => {
      await expect(
        fixture.d1.batch([
          fixture.d1.prepare("INSERT INTO entries (value) VALUES ('kept')"),
          fixture.d1.prepare("INSERT INTO entries (value) VALUES ('kept')"),
        ]),
      ).rejects.toThrow()

      expect(await fixture.d1.prepare('SELECT value FROM entries').all()).toMatchObject({
        results: [],
        success: true,
      })
    })

    it('returns reader rows from run and all', async () => {
      await fixture.d1.prepare("INSERT INTO entries (value) VALUES ('readable')").run()

      const query = 'SELECT value FROM entries'
      const run = await fixture.d1.prepare(query).run<{ value: string }>()
      const all = await fixture.d1.prepare(query).all<{ value: string }>()

      for (const result of [run, all]) {
        expect(result).toMatchObject({ success: true, results: [{ value: 'readable' }] })
      }
      expect(await fixture.d1.prepare(query).first<{ value: string }>()).toEqual({
        value: 'readable',
      })
    })
  })
}
