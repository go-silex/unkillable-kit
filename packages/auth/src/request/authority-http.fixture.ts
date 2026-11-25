import { AppError } from '@kit/core'
import type { KitD1Database } from '@kit/db'
import { countD1RoundTrips } from '@kit/db/testing'
import type Database from 'better-sqlite3'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type Mock, vi } from 'vitest'
import { createRequestAuthorization } from '../hono'
import {
  type AuthorizationRow,
  defineAuthorizationFact,
  defineAuthorizationProjection,
} from '../snapshot'
import { authorizationDatabase } from './authorization-hono.fixture'

export const path = '/orgs/alpha/authority'
export const header = 'X-Authority-Fingerprint'
export const privateLabel = 'synthetic-private-tuple'
export const siblingLabel = 'synthetic-private-sibling'
export const effectSql = 'INSERT INTO fixture_effects DEFAULT VALUES'
const projection = defineAuthorizationProjection({
  table: {
    name: 'fixture_visibility',
    columns: ['organization_id', 'user_id', 'position', 'label', 'visible'],
  },
  scope: { kind: 'organization-role', organizationId: 'organization_id', userId: 'user_id' },
  select: ['position', 'label'],
  where: { visible: 1 },
})

type BatchResult = { success: boolean; results: Record<string, unknown>[] }
export type Trace = {
  response: Response
  trips: number
  prepared: string[]
  batches: BatchResult[][]
}
export const containsValue = (result: BatchResult, value: string) =>
  result.results.some((row) => Object.values(row).includes(value))

export async function authorityFixture(customHeader?: string): Promise<{
  decode: Mock<(rows: readonly AuthorizationRow[]) => string | number | null | undefined>
  failure: { value: string | undefined }
  key: string
  read: Mock<(c: Context) => Promise<Response>>
  request(init?: RequestInit, location?: string): Promise<Trace>
  seed(position: string, label: string, org?: string, user?: string, visible?: number): void
  sqlite: Database.Database
  userId: string
  write: Mock<(c: Context) => Promise<Response>>
}> {
  const { auth, availability, cookie, grant, key, realDb, sqlite, userId } =
    await authorizationDatabase()
  sqlite.exec(
    [
      "UPDATE organization_role_module_grants SET access = 'write'",
      'CREATE TABLE fixture_visibility (' +
        'organization_id TEXT NOT NULL COLLATE NOCASE, user_id TEXT NOT NULL COLLATE NOCASE, ' +
        'position TEXT NOT NULL, label TEXT NOT NULL, visible INTEGER NOT NULL)',
      'CREATE TABLE fixture_effects (id INTEGER PRIMARY KEY)',
      'CREATE TABLE fixture_sibling (organization_id TEXT NOT NULL, label TEXT NOT NULL)',
    ].join('; '),
  )
  sqlite.prepare('INSERT INTO fixture_sibling VALUES (?, ?)').run('alpha', siblingLabel)
  const insert = sqlite.prepare('INSERT INTO fixture_visibility VALUES (?, ?, ?, ?, ?)')
  function seed(position: string, label: string, org = 'alpha', user = userId, visible = 1) {
    insert.run(org, user, position, label, visible)
  }

  const decode = vi.fn((rows: readonly AuthorizationRow[]) => rows[0]?.label)
  const sibling = defineAuthorizationFact({
    table: { name: 'fixture_sibling', columns: ['organization_id', 'label'] },
    scope: { kind: 'organization', organizationId: 'organization_id' },
    select: ['label'],
    maxRows: 1,
    decode,
  })
  const prepared: string[] = []
  const batches: BatchResult[][] = []
  const failure = { value: undefined as string | undefined }
  const decorated: KitD1Database = {
    ...realDb,
    prepare(sql) {
      prepared.push(sql)
      return realDb.prepare(sql)
    },
    async batch(statements) {
      const results = (await realDb.batch(statements)) as BatchResult[]
      if (failure.value !== undefined) {
        const value = failure.value
        const index = results.findIndex((result) => containsValue(result, value))
        if (index !== -1) results[index] = { success: false, results: [] }
      }
      batches.push(results)
      return results
    },
  }
  let binding = decorated
  const authorization = createRequestAuthorization({
    auth: () => auth,
    db: () => binding,
    moduleFacts: (id) => (id === 'notes' ? { availability, grant } : undefined),
  })
  const authority = authorization.moduleAuthority('notes', {
    view: 'fixture-view',
    projection,
    ...(customHeader ? { header: customHeader } : {}),
  })
  const read = vi.fn(async (c: Context) =>
    c.json({
      fingerprint: await authority.fingerprint(c),
      sibling: await authorization.fact(c, sibling),
    }),
  )
  const write = vi.fn(async (c: Context) => {
    await authorization.fact(c, sibling)
    await binding.prepare(effectSql).run()
    return c.json({ written: true })
  })
  const app = new Hono()
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ message: error.message }, error.status as ContentfulStatusCode)
      : c.json({ message: 'Unexpected error' }, 500),
  )
  const guards = [
    authorization.requireAuth,
    authorization.requireOrgContext(),
    authorization.includeFacts(sibling),
  ] as const
  app.get('/orgs/:orgId/authority', ...guards, authority.read, read)
  app.post('/orgs/:orgId/authority', ...guards, authority.write, write)
  app.get(
    '/orgs/:orgId/authority/early',
    ...guards,
    async (c) => {
      const accesses = await Promise.allSettled([
        authorization.fact(c, projection),
        authorization.fact(c, sibling),
        Promise.resolve().then(() => authority.fingerprint(c)),
      ])
      const statuses = accesses.map((result) =>
        result.status === 'rejected' && result.reason instanceof AppError
          ? result.reason.status
          : 'unexpected',
      )
      return c.json({ statuses })
    },
    authority.read,
    read,
  )
  app.post(
    '/orgs/:orgId/authority/misplaced',
    ...guards,
    authority.write,
    authorization.requireOrgRole('admin'),
    write,
  )

  async function request(init?: RequestInit, location = path): Promise<Trace> {
    prepared.length = 0
    batches.length = 0
    const measured = countD1RoundTrips(decorated)
    binding = measured.db
    const headers = new Headers(init?.headers)
    if (!headers.has('cookie')) headers.set('cookie', cookie)
    try {
      const response = await app.request(location, { ...init, headers })
      return { response, trips: measured.count, prepared: [...prepared], batches: [...batches] }
    } finally {
      binding = decorated
    }
  }
  return { decode, failure, key, read, request, seed, sqlite, userId, write }
}
