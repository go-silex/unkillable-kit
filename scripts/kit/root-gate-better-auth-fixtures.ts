import { Database, type SQLQueryBindings } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KitBetterAuth } from '../../packages/auth/src/factory'
import type { resolveRequestSession } from '../../packages/auth/src/snapshot'
import { createSqliteD1, type SqliteD1 } from '../../packages/db/src/test/sqlite-d1'
import type { BetterAuthApp } from './root-gate-better-auth-apps'

const secret = crypto.randomUUID()
const wrongSecret = crypto.randomUUID()
const origin = 'https://root-fixture.example.invalid'
const email = 'root-differential@example.invalid'
const password = crypto.randomUUID()

type Factory = (
  env: {
    DB: SqliteD1
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL: string
    ALLOW_PUBLIC_SIGNUP: string
    CORS_ORIGINS: string
    ENVIRONMENT: string
    SESSION_COOKIE_NAME: string
  },
  baseURL: string,
) => KitBetterAuth

type Profile = { logical: string; secure: boolean; remember: boolean }

/** Keep Root on Bun while using the same D1 adapter as the existing Node/SQLite suites. */
function binding(sqlite: Database) {
  const adapter = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      return {
        get: (...values: SQLQueryBindings[]) => statement.get(...values),
        all: (...values: SQLQueryBindings[]) => statement.all(...values),
        reader: statement.columnNames.length > 0,
        raw: () => ({ all: (...values: SQLQueryBindings[]) => statement.values(...values) }),
        run: (...values: SQLQueryBindings[]) => statement.run(...values),
      }
    },
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn: Parameters<Database['transaction']>[0]) => sqlite.transaction(fn),
  }
  return createSqliteD1(adapter as unknown as Parameters<typeof createSqliteD1>[0])
}

function fixtureApp(
  create: Factory,
  sqlite: Database,
  profile: Profile,
  authSecret: string = secret,
) {
  const db = binding(sqlite)
  const auth = create(
    {
      DB: db,
      ENVIRONMENT: profile.secure ? 'production' : 'test',
      ALLOW_PUBLIC_SIGNUP: 'true',
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: origin,
      CORS_ORIGINS: origin,
      SESSION_COOKIE_NAME: profile.logical,
    },
    origin,
  )
  return { db, auth }
}

function rowCount(db: Database, id: string) {
  return db
    .query<{ count: number }, [string]>('SELECT count(*) AS count FROM session WHERE id = ?')
    .get(id)?.count
}

function changes(db: Database) {
  return db.query<{ count: number }, []>('SELECT total_changes() AS count').get()?.count
}

async function atTime<T>(millisecond: number, run: () => Promise<T>): Promise<T> {
  const original = globalThis.Date
  globalThis.Date = new Proxy(original, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [millisecond], newTarget)
    },
    get(target, property, receiver) {
      return property === 'now' ? () => millisecond : Reflect.get(target, property, receiver)
    },
  })
  try {
    return await run()
  } finally {
    globalThis.Date = original
  }
}

async function issue(auth: KitBetterAuth, sqlite: Database, profile: Profile) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Root Fixture', email, password, rememberMe: profile.remember }),
    }),
  )
  assert.ok(
    response.ok,
    `App did not issue a session: HTTP ${response.status} ${await response.text()}`,
  )
  const rows = sqlite
    .query<{ subject: string; sessionId: string; token: string }, []>(
      'SELECT user_id AS subject, id AS sessionId, token FROM session',
    )
    .all()
  assert.equal(rows.length, 1, 'issuance must persist exactly one session')
  const [{ subject, sessionId, token }] = rows
  const cookies = response.headers.getSetCookie()
  const issued = cookies.find((cookie) => {
    const value = cookie.split(';', 1)[0].slice(cookie.indexOf('=') + 1)
    return decodeURIComponent(value).startsWith(`${token}.`)
  })
  assert.ok(issued, 'App must write the stored session token in a signed cookie')
  const wire = issued.slice(0, issued.indexOf('='))
  assert.equal(wire, profile.secure ? `__Secure-${profile.logical}` : profile.logical)
  assert.equal(/;\s*Secure(?:;|$)/i.test(issued), profile.secure)
  assert.equal(/;\s*Max-Age=/i.test(issued), profile.remember)
  const session = issued.split(';', 1)[0]
  const dontRemember = cookies
    .find((cookie) => /^(?:__Secure-)?better-auth\.dont_remember=/.test(cookie))
    ?.split(';', 1)[0]
  assert.equal(Boolean(dontRemember), !profile.remember, 'expected real dont_remember cookie')
  return { wire, session, dontRemember, identity: { subject, sessionId, email } }
}

type Fixture = {
  name: string
  cookie?: string
  allowed: boolean
  secret?: string
  change?: (db: Database) => void
}

export async function runBetterAuthDifferential(app: BetterAuthApp) {
  // Root discovers the App and its exact shipping modules at runtime.
  const composition: { createBetterAuth: Factory } = await import(
    pathToFileURL(app.composition).href
  )
  const snapshotPath = Bun.resolveSync('@kit/auth/snapshot', dirname(app.composition))
  const snapshot: { resolveRequestSession: typeof resolveRequestSession } = await import(
    pathToFileURL(snapshotPath).href
  )
  const migrations = join(app.dir, 'migrations')
  const migrationSql = readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(migrations, name), 'utf8'))

  for (const profile of [
    { logical: 'kit_session', secure: false, remember: true },
    { logical: 'product_session', secure: false, remember: true },
    { logical: 'product_session', secure: true, remember: true },
    { logical: '__Secure-product_session', secure: true, remember: false },
  ]) {
    const create = composition.createBetterAuth
    using issuer = new Database(':memory:')
    issuer.exec('PRAGMA foreign_keys = ON')
    for (const sql of migrationSql) issuer.exec(sql)
    const initial = fixtureApp(create, issuer, profile)
    const { wire, session, dontRemember, identity } = await issue(initial.auth, issuer, profile)
    const image = issuer.serialize()
    const value = session.slice(wire.length + 1)
    const signatureStart = value.lastIndexOf('.') + 1
    assert.ok(
      signatureStart > 0 && signatureStart < value.length,
      'expected an issued signed cookie',
    )
    const badSignature = `${wire}=${value.slice(0, signatureStart)}${value[signatureStart] === 'A' ? 'B' : 'A'}${value.slice(signatureStart + 1)}`
    const cookie = dontRemember ? `${session}; ${dontRemember}` : session
    const now = Date.now()
    const expires = (at: number) => (db: Database) => {
      db.query<unknown, [number, string]>('UPDATE session SET expires_at = ? WHERE id = ?').run(
        at,
        identity.sessionId,
      )
    }
    const cases: Fixture[] = [
      { name: dontRemember ? 'dont_remember' : 'valid', cookie, allowed: true },
      { name: 'tampered signature', cookie: badSignature, allowed: false },
      { name: 'wrong secret', cookie, secret: wrongSecret, allowed: false },
      { name: 'missing', allowed: false },
      { name: 'malformed', cookie: `${wire}=not-a-signed-cookie`, allowed: false },
      {
        name: 'wrong wire name',
        cookie: `${profile.secure ? profile.logical : `__Secure-${wire}`}=${value}`,
        allowed: false,
      },
      { name: 'first duplicate valid', cookie: `${session}; ${badSignature}`, allowed: true },
      { name: 'first duplicate invalid', cookie: `${badSignature}; ${session}`, allowed: false },
      { name: 'expiry at current millisecond', cookie, allowed: true, change: expires(now) },
      { name: 'expired one millisecond ago', cookie, allowed: false, change: expires(now - 1) },
      {
        name: 'deleted',
        cookie,
        allowed: false,
        change: (db) => {
          db.query<unknown, [string]>('DELETE FROM session WHERE id = ?').run(identity.sessionId)
        },
      },
      {
        name: 'disabled User',
        cookie,
        allowed: false,
        change: (db) => {
          db.query<unknown, [string]>('UPDATE user SET disabled = 1 WHERE id = ?').run(
            identity.subject,
          )
        },
      },
    ]
    for (const test of cases) {
      using referenceDb = Database.deserialize(image)
      using verifierDb = Database.deserialize(image)
      const reference = fixtureApp(create, referenceDb, profile, test.secret)
      const verifier = fixtureApp(create, verifierDb, profile, test.secret)
      const label = `${app.workspace} (${wire}): ${test.name}`
      async function assertBoth(
        expected: typeof identity | null,
        cookieHeader: string | undefined,
        message: string,
      ) {
        const headers = new Headers(cookieHeader ? { cookie: cookieHeader } : undefined)
        const expectedSessionCount = rowCount(verifierDb, identity.sessionId)
        const before = changes(verifierDb)
        const actual = await snapshot.resolveRequestSession({
          db: verifier.db,
          auth: verifier.auth,
          headers,
        })
        assert.deepEqual(
          actual,
          expected && { ...expected, method: 'session' },
          `${label}: ${message} (Kit)`,
        )
        assert.equal(
          rowCount(verifierDb, identity.sessionId),
          expectedSessionCount,
          `${label}: no session cleanup`,
        )
        assert.equal(changes(verifierDb), before, `${label}: no D1 writes`)
        assert.equal(headers.get('set-cookie'), null, `${label}: no Set-Cookie`)
        assert.equal(
          headers.get('cookie'),
          cookieHeader ?? null,
          `${label}: cookie input is read-only`,
        )

        const oracle = await reference.auth.api.getSession({
          headers: new Headers(cookieHeader ? { cookie: cookieHeader } : undefined),
          query: { disableCookieCache: true, disableRefresh: true },
        })
        assert.deepEqual(
          oracle && {
            subject: oracle.user.id,
            sessionId: oracle.session.id,
            email: oracle.user.email,
          },
          expected,
          `${label}: ${message} (Better Auth)`,
        )
      }
      await atTime(now, async () => {
        if (test.change) {
          await assertBoth(identity, test.cookie, 'same cookie admitted before changing state')
          test.change(referenceDb)
          test.change(verifierDb)
        }
        if (test.name.startsWith('expired'))
          assert.equal(rowCount(verifierDb, identity.sessionId), 1)
        await assertBoth(
          test.allowed ? identity : null,
          test.cookie,
          'expected admission and identity',
        )
      })
    }
  }
}
