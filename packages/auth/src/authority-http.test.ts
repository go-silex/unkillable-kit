import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  authorityFixture,
  containsValue,
  effectSql,
  expectNoEffect,
  header,
  path,
  privateLabel,
  siblingLabel,
  type Trace,
  watchLogs,
} from './request/authority-http.fixture'

type DatabaseFixture = { sqlite: Database.Database }

function expectReadOnly(fixture: DatabaseFixture, trace: Trace, trips = 1) {
  expect(trace.trips).toBe(trips)
  expect(trace.batches).toHaveLength(trips)
  if (trips === 0) expect(trace.prepared).toEqual([])
  for (const sql of trace.prepared) expect(fixture.sqlite.prepare(sql).readonly).toBe(true)
}

function observedProjection(trace: Trace) {
  return trace.batches.flatMap((batch) =>
    batch.flatMap(({ results }) =>
      results.flatMap((row) => (typeof row.projection === 'string' ? [row.projection] : [])),
    ),
  )
}

async function readAuthority(fixture: DatabaseFixture & { request(): Promise<Trace> }) {
  const trace = await fixture.request()
  expectReadOnly(fixture, trace)
  expect(trace.response.status).toBe(200)
  const result = (await trace.response.json()) as {
    fingerprint: string
    sibling: string
  }
  expect(result).toEqual({ fingerprint: expect.any(String), sibling: siblingLabel })
  expect(result.fingerprint).not.toBe('')
  // The projection is private even when admitted; read the exact aggregate at the D1 seam.
  const aggregates = observedProjection(trace)
  expect(aggregates).toHaveLength(1)
  return { ...result, tuples: JSON.parse(aggregates[0] as string) as [string, string][] }
}

function post(fingerprint?: string, name = header): RequestInit {
  return { method: 'POST', headers: fingerprint === undefined ? {} : { [name]: fingerprint } }
}

async function expectRefusal(trace: Trace, status: number, message: string) {
  expect(trace.response.status).toBe(status)
  expect(trace.response.headers.has(header)).toBe(false)
  expect(await trace.response.json()).toEqual({ message })
}

describe('HTTP Module authority fingerprint', () => {
  it('admits all 128 and 129 ordered tuples and detects change and removal of the final tuple', async () => {
    const f = await authorityFixture()
    const expected: [string, string][] = Array.from({ length: 32 }, (_, index) =>
      String(index).padStart(2, '0'),
    ).flatMap((position) =>
      ['a', 'a', 'b', 'c'].map((label): [string, string] => [position, label]),
    )
    for (const [position, label] of [...expected].reverse()) f.seed(position, label)
    const at128 = await readAuthority(f)
    expect(at128.tuples).toEqual(expected)
    f.seed('32', privateLabel)
    const at129 = await readAuthority(f)
    expect(at129.tuples).toEqual([...expected, ['32', privateLabel]])
    expect(at129.fingerprint).not.toBe(at128.fingerprint)
    f.decode.mockClear()
    const noLoggedSecrets = watchLogs()

    f.sqlite
      .prepare("UPDATE fixture_visibility SET label = ? WHERE position = '32'")
      .run('replacement')
    const changed = await f.request(post(at129.fingerprint))
    expectReadOnly(f, changed)
    await expectRefusal(changed, 409, 'Authority fingerprint changed')
    expect(f.decode).not.toHaveBeenCalled()
    const latest = await readAuthority(f)
    expect(latest.tuples).toEqual([...expected, ['32', 'replacement']])
    f.decode.mockClear()
    f.sqlite.exec("DELETE FROM fixture_visibility WHERE position = '32'")
    const removed = await f.request(post(latest.fingerprint))
    expectReadOnly(f, removed)
    await expectRefusal(removed, 409, 'Authority fingerprint changed')
    expect(f.decode).not.toHaveBeenCalled()
    expect((await readAuthority(f)).fingerprint).toBe(at128.fingerprint)
    expectNoEffect(f)
    noLoggedSecrets(at129.fingerprint, latest.fingerprint, 'replacement')
  })

  it('scopes the projection to the exact Organization and User before applying a narrowing predicate', async () => {
    const f = await authorityFixture()
    f.seed('01', privateLabel)
    const initial = await readAuthority(f)
    const upperCaseUserId = f.userId.toUpperCase()
    const otherUser = f.userId === upperCaseUserId ? f.userId.toLowerCase() : upperCaseUserId
    expect(otherUser).not.toBe(f.userId)
    f.seed('02', 'outside-org', 'ALPHA')
    f.seed('03', 'outside-user', 'alpha', otherUser)
    f.seed('04', 'not-visible', 'alpha', f.userId, 0)
    f.sqlite.exec("UPDATE fixture_visibility SET label = 'still-outside' WHERE position > '01'")
    expect(await readAuthority(f)).toEqual(initial)
    f.sqlite.exec("UPDATE fixture_visibility SET organization_id = 'ALPHA' WHERE position = '01'")
    const movedOrg = await f.request(post(initial.fingerprint))
    expectReadOnly(f, movedOrg)
    await expectRefusal(movedOrg, 409, 'Authority fingerprint changed')
    expect((await readAuthority(f)).tuples).toEqual([])
    f.sqlite.exec("UPDATE fixture_visibility SET organization_id = 'alpha' WHERE position = '01'")
    expect(await readAuthority(f)).toEqual(initial)
    f.sqlite
      .prepare("UPDATE fixture_visibility SET user_id = ? WHERE position = '01'")
      .run(otherUser)
    const movedUser = await f.request(post(initial.fingerprint))
    expectReadOnly(f, movedUser)
    await expectRefusal(movedUser, 409, 'Authority fingerprint changed')
    expect((await readAuthority(f)).tuples).toEqual([])
    expectNoEffect(f)
  })

  it('uses the live grant, then refuses write access even with a fresh read-only fingerprint', async () => {
    const f = await authorityFixture()
    f.seed('01', privateLabel)
    const before = await readAuthority(f)
    f.decode.mockClear()
    const noLoggedSecrets = watchLogs()
    f.sqlite.exec("UPDATE organization_role_module_grants SET access = 'read'")
    const stale = await f.request(post(before.fingerprint))
    expectReadOnly(f, stale)
    await expectRefusal(stale, 409, 'Authority fingerprint changed')
    expect(f.decode).not.toHaveBeenCalled()
    const fresh = await readAuthority(f)
    expect(fresh.tuples).toEqual(before.tuples)
    expect(fresh.fingerprint).not.toBe(before.fingerprint)
    f.decode.mockClear()
    const matching = await f.request(post(fresh.fingerprint))
    expectReadOnly(f, matching)
    await expectRefusal(matching, 403, 'Insufficient module grant')
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.decode).not.toHaveBeenCalled()
    expectNoEffect(f)
    noLoggedSecrets(before.fingerprint, fresh.fingerprint)
  })

  it.each([undefined, 'X-Fixture-Authority'])(
    'accepts the configured header (%s) and keeps the admitted effect separate',
    async (customHeader) => {
      const f = await authorityFixture(customHeader)
      const { fingerprint } = await readAuthority(f)
      expectNoEffect(f)
      if (customHeader) {
        f.decode.mockClear()
        const wrongHeader = await f.request(post(fingerprint))
        expectReadOnly(f, wrongHeader)
        await expectRefusal(wrongHeader, 400, 'Invalid authority fingerprint')
        expect(wrongHeader.response.headers.has(customHeader)).toBe(false)
        expect(f.decode).not.toHaveBeenCalled()
        expectNoEffect(f)
      }
      const accepted = await f.request(post(fingerprint, customHeader))
      expect(accepted.response.status).toBe(200)
      expect(await accepted.response.json()).toEqual({ written: true })
      expect(accepted.trips).toBe(2)
      expect(accepted.prepared.at(-1)).toBe(effectSql)
      expectReadOnly(f, {
        ...accepted,
        trips: accepted.trips - 1,
        prepared: accepted.prepared.slice(0, -1),
      })
      expect(f.write).toHaveBeenCalledTimes(1)
      expect(f.sqlite.prepare('SELECT id FROM fixture_effects').all()).toEqual([{ id: 1 }])
    },
  )

  it.each([
    ['no session', 401, 'Unauthorized', 0],
    ['unverified Bearer with a valid session cookie', 401, 'Unauthorized', 1],
    ['Organization not admitted', 404, 'Organization not found', 1],
    ['suspended Organization with JSONB in the projection', 403, 'Organization is not active', 1],
    ['unavailable Module', 404, 'Module not available', 1],
    ['no live read grant', 403, 'Insufficient module grant', 1],
    ['missing fingerprint', 400, 'Invalid authority fingerprint', 1],
    ['malformed fingerprint', 400, 'Invalid authority fingerprint', 1],
    ['unreadable projection', 503, 'Authorization unavailable', 1],
    ['unsupported JSONB projection value', 503, 'Authorization unavailable', 1],
    ['D1 execution failure', 503, 'Authorization unavailable', 1],
    ['failed sibling with a current fingerprint', 503, 'Authorization unavailable', 1],
    ['failed sibling with a stale fingerprint', 503, 'Authorization unavailable', 1],
    ['later Kit guard', 503, 'Authorization unavailable', 0],
  ] as const)(
    'preserves the refusal for %s without exposing facts or running an effect',
    async (reason, status, message, trips) => {
      const f = await authorityFixture()
      f.seed('01', privateLabel)
      const { fingerprint } = await readAuthority(f)
      f.read.mockClear()
      f.decode.mockClear()
      const noLoggedSecrets = watchLogs()
      const aggregate = JSON.stringify([['01', privateLabel]])
      const headers = new Headers({ [header]: 'malformed' })
      let location = path
      switch (reason) {
        case 'no session':
          headers.set('cookie', '')
          break
        case 'unverified Bearer with a valid session cookie':
          headers.set('authorization', `Bearer ${f.key}invalid`)
          break
        case 'Organization not admitted':
          f.sqlite.exec('DELETE FROM member')
          break
        case 'suspended Organization with JSONB in the projection':
          f.sqlite.exec("UPDATE organization SET status = 'suspended'")
          f.sqlite.exec("UPDATE fixture_visibility SET label = jsonb(1) WHERE position = '01'")
          break
        case 'unavailable Module':
          f.sqlite.exec('UPDATE platform_modules SET available = 0')
          break
        case 'no live read grant':
          f.sqlite.exec('DELETE FROM organization_role_module_grants')
          break
        case 'missing fingerprint':
          headers.delete(header)
          break
        case 'unreadable projection':
          f.failure.value = aggregate
          break
        case 'unsupported JSONB projection value':
          f.sqlite
            .prepare("UPDATE fixture_visibility SET label = jsonb(?) WHERE position = '01'")
            .run(JSON.stringify(privateLabel))
          headers.set(header, fingerprint)
          break
        case 'D1 execution failure':
          f.sqlite.exec('DROP TABLE fixture_visibility')
          headers.set(header, fingerprint)
          break
        case 'failed sibling with a current fingerprint':
        case 'failed sibling with a stale fingerprint':
          f.failure.value = siblingLabel
          headers.set(header, reason.includes('stale') ? '0'.repeat(64) : fingerprint)
          break
        case 'later Kit guard':
          headers.set(header, fingerprint)
          location += '/misplaced'
          break
      }
      const refused = await f.request({ method: 'POST', headers }, location)
      if (reason === 'D1 execution failure') {
        expect(refused.trips).toBe(1)
        expect(refused.batches).toEqual([])
        expect(refused.prepared).not.toContain(effectSql)
      } else {
        expectReadOnly(f, refused, trips)
      }
      await expectRefusal(refused, status, message)
      const projection = observedProjection(refused)
      if (reason === 'unsupported JSONB projection value') expect(projection).toHaveLength(1)
      if (reason === 'unavailable Module' || reason === 'no live read grant') {
        expect(projection).toEqual([])
      }
      if (reason.startsWith('suspended')) expect(projection).toEqual(['[]'])
      if (reason.startsWith('failed sibling')) {
        expect(projection).toEqual([aggregate])
        expect(refused.batches[0]).toContainEqual({ success: false, results: [] })
      }
      if (reason === 'unreadable projection') {
        expect(refused.batches[0]?.some((result) => containsValue(result, siblingLabel))).toBe(true)
      }
      expect(f.read).not.toHaveBeenCalled()
      expect(f.decode).not.toHaveBeenCalled()
      expectNoEffect(f)
      noLoggedSecrets(fingerprint, 'fixture_visibility', 'no such table')
    },
  )

  it('does not release declared facts or a fingerprint before the standalone read guard runs', async () => {
    const f = await authorityFixture()
    f.seed('01', privateLabel)
    const noLoggedSecrets = watchLogs()
    const early = await f.request(undefined, `${path}/early`)
    expectReadOnly(f, early)
    expect(
      early.batches[0]?.some((result) =>
        containsValue(result, JSON.stringify([['01', privateLabel]])),
      ),
    ).toBe(true)
    expect(early.response.status).toBe(200)
    expect(await early.response.json()).toEqual({ statuses: [403, 403, 403] })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.decode).not.toHaveBeenCalled()
    expectNoEffect(f)
    noLoggedSecrets()
  })
})
