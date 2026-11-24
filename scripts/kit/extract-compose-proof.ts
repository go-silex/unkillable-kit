#!/usr/bin/env bun
/**
 * CP-EXTRACT compose proof — temp @kit/* app, migrations, tsc, credential-bound Hono routes.
 *
 * Env: EXTRACT_ROOT — monorepo root.
 * Exit: 0 pass · 1 fail
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(process.env.EXTRACT_ROOT ?? join(import.meta.dirname, '../..'))
const MIG_DIR = join(ROOT, 'apps/example-api/migrations')
const API_PKG = join(ROOT, 'apps/example-api/package.json')
const requireApi = createRequire(API_PKG)

function findBunStoreModules(prefix: string): string {
  const bunDir = join(ROOT, 'node_modules/.bun')
  if (!existsSync(bunDir)) throw new Error('node_modules/.bun missing — run bun install')
  for (const ent of readdirSync(bunDir)) {
    if (ent.startsWith(prefix)) return join(bunDir, ent, 'node_modules')
  }
  throw new Error(`bun package not found: ${prefix}`)
}

function resolveDep(spec: string): string {
  return dirname(requireApi.resolve(`${spec}/package.json`))
}

function pkgSrc(pkg: string, sub: string): string {
  return join(ROOT, 'packages', pkg, 'src', sub)
}

function kitPaths(): Record<string, string[]> {
  const nm = resolveDep('hono')
  const drizzle = resolveDep('drizzle-orm')
  return {
    '@kit/auth': [pkgSrc('auth', 'index.ts')],
    '@kit/auth/factory': [pkgSrc('auth', 'better-auth-factory.ts')],
    '@kit/auth/hono': [pkgSrc('auth', 'hono.ts')],
    '@kit/auth/repos/keys': [pkgSrc('auth', 'repos/keys.ts')],
    '@kit/auth/repos/orgs': [pkgSrc('auth', 'repos/orgs.ts')],
    '@kit/auth/schema': [pkgSrc('auth', 'better-auth-schema.ts')],
    '@kit/db': [pkgSrc('db', 'index.ts')],
    '@kit/core': [pkgSrc('core', 'index.ts')],
    '@kit/types': [pkgSrc('types', 'index.ts')],
    hono: [join(nm, 'dist/types/index.d.ts')],
    'drizzle-orm': [join(drizzle, 'index.d.ts')],
    'drizzle-orm/*': [join(drizzle, '*')],
    'drizzle-orm/d1': [join(drizzle, 'd1/index.d.ts')],
    'drizzle-orm/sqlite-core': [join(drizzle, 'sqlite-core/index.d.ts')],
    zod: [join(resolveDep('zod'), 'index.d.cts')],
  }
}

const SQLITE_SHIM = `declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): {
      get(...args: unknown[]): unknown
      run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint }
      all(...args: unknown[]): unknown[]
      values(...args: unknown[]): unknown[][]
    }
    close(): void
  }
}
`

const PROOF_APP = `import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { apiKeyPrefix, generateApiKey, hashApiKey, parseBearer } from '@kit/auth'
import { createBetterAuth, type KitBetterAuth } from '@kit/auth/factory'
import { createRequestAuthorization } from '@kit/auth/hono'
import { insertApiKey } from '@kit/auth/repos/keys'
import * as orgsRepo from '@kit/auth/repos/orgs'
import { kitAuthSchema } from '@kit/auth/schema'
import { AppError } from '@kit/core'
import { createDb, type KitD1Statement } from '@kit/db'

type AppEnv = {
  Variables: { subject?: string; authMethod?: 'session' | 'api_key'; orgId?: string }
}

const MIG_DIR = process.env.KIT_MIG_DIR!

function applyMigrations(sqlite: Database) {
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const name of readdirSync(MIG_DIR).filter((f: string) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIG_DIR, name), 'utf8'))
  }
}

function makeD1(sqlite: Database) {
  function stmt(sql: string): KitD1Statement {
    let binds: unknown[] = []
    const s = {
      bind(...args: unknown[]) {
        binds = args
        return s
      },
      async first<T>() {
        return (sqlite.prepare(sql).get(...binds) ?? null) as T | null
      },
      async run() {
        const info = sqlite.prepare(sql).run(...binds)
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } }
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...binds), success: true }
      },
      async raw<T>() {
        return sqlite.prepare(sql).values(...binds) as T[][]
      },
    }
    return s
  }
  return {
    prepare(sql: string) {
      return stmt(sql)
    },
    async batch(stmts: unknown[]) {
      const out: unknown[] = []
      for (const item of stmts) {
        const statement = item as KitD1Statement // Prepared by this adapter.
        out.push(await statement.all())
      }
      return out
    },
    async exec(query: string) {
      sqlite.exec(query)
      return { count: 1, duration: 0 }
    },
  }
}

export async function runComposeProof(): Promise<void> {
  const sqlite = new Database(':memory:')
  applyMigrations(sqlite)
  const binding = makeD1(sqlite)
  const db = createDb(binding, kitAuthSchema)
  const origin = 'https://compose-proof.kit.test'
  const auth: KitBetterAuth = createBetterAuth({
    database: binding,
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: origin,
    trustedOrigins: [origin],
    allowPublicSignup: true,
    cookieName: 'compose-proof-session',
    useSecureCookies: true,
  })
  const app = new Hono<AppEnv>()
  const authorization = createRequestAuthorization<AppEnv>({
    db: () => binding,
    auth: () => auth,
  })
  app.all('/api/auth/*', (c) => auth.handler(c.req.raw))
  app.get(
    '/orgs/:orgId/ping',
    async (c, next) => {
      if (parseBearer(c.req.header('authorization'))) {
        const { scopes } = await authorization.authenticateKey(c)
        if (!scopes.includes('read')) throw AppError.forbidden()
        authorization.admitKeyScope(c)
      }
      await next()
    },
    authorization.requireAuth,
    authorization.requireOrgContext(),
    (c) => c.json({ subject: c.get('subject'), authMethod: c.get('authMethod'), orgId: c.get('orgId') }),
  )
  app.onError((err, c) => {
    const raw = 'status' in err ? err.status : 500
    const status = raw === 404 || raw === 401 || raw === 403 || raw === 400 ? raw : 500
    return c.json({ message: err instanceof Error ? err.message : 'error' }, status)
  })
  const request = (path: string, init?: RequestInit) => app.request(origin + path, init)
  const signup = await request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ name: 'User', email: 'user@kit.test', password: crypto.randomUUID() }),
  })
  if (signup.status !== 200) throw new Error('expected Better Auth signup 200, got ' + signup.status)
  const { user } = (await signup.json()) as { user: { id: string } }
  const cookie = signup.headers.getSetCookie()
    .find((value) => value.startsWith('__Secure-compose-proof-session='))?.split(';', 1)[0]
  if (!cookie) throw new Error('Better Auth did not issue the configured session cookie')
  const now = new Date(0)
  await orgsRepo.insertOrganization(db, {
    id: 'org-a',
    name: 'Org A',
    slug: 'org-a',
    kind: 'client',
    status: 'active',
    createdAt: now,
  })
  await orgsRepo.insertOrganization(db, {
    id: 'org-b',
    name: 'Org B',
    slug: 'org-b',
    kind: 'client',
    status: 'active',
    createdAt: now,
  })
  await orgsRepo.insertMember(db, {
    id: 'm1',
    organizationId: 'org-a',
    userId: user.id,
    role: 'member',
    createdAt: now,
  })

  const key = generateApiKey()
  await insertApiKey(db, {
    id: 'key-1',
    keyHash: await hashApiKey(key),
    keyPrefix: apiKeyPrefix(key),
    subject: user.id,
    organizationId: 'org-a',
    scopes: 'read',
    createdAt: now.getTime(),
  })

  const ownPath = '/orgs/org-a/ping'
  for (const [headers, authMethod] of [
    [new Headers({ cookie }), 'session'],
    [new Headers({ cookie, authorization: 'Bearer ' + key }), 'api_key'],
  ] as const) {
    const ok = await request(ownPath, { headers })
    if (ok.status !== 200) throw new Error('expected ' + authMethod + ' 200, got ' + ok.status)
    const body = (await ok.json()) as { subject: string; authMethod: string; orgId: string }
    if (body.subject !== user.id || body.authMethod !== authMethod || body.orgId !== 'org-a') {
      throw new Error('incorrect context for ' + authMethod)
    }
  }
  for (const [path, headers, expected] of [
    ['/orgs/org-b/ping', { cookie }, 404],
    ['/orgs/org-b/ping', { cookie, authorization: 'Bearer ' + key }, 403],
    [ownPath, { cookie, authorization: 'Bearer ' + generateApiKey() }, 401],
    [ownPath, undefined, 401],
  ] as const) {
    const denied = await request(path, { headers: new Headers(headers) })
    if (denied.status !== expected) {
      throw new Error('expected ' + expected + ' for ' + path + ', got ' + denied.status)
    }
  }

  sqlite.close()
}

await runComposeProof()
`

async function main(): Promise<void> {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const tmp = mkdtempSync(join(ROOT, '.tmp', 'kit-compose-proof-'))
  try {
    writeFileSync(join(tmp, 'proof-app.ts'), PROOF_APP)
    writeFileSync(join(tmp, 'bun-sqlite.d.ts'), SQLITE_SHIM)
    const nodeTypes = join(findBunStoreModules('@types+node@'), '@types')
    writeFileSync(
      join(tmp, 'tsconfig.tsc.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            lib: ['ES2022', 'DOM'],
            typeRoots: [nodeTypes],
            types: ['node'],
            paths: kitPaths(),
          },
          include: ['proof-app.ts', 'bun-sqlite.d.ts'],
        },
        null,
        2,
      ),
    )

    const tsc = spawnSync('bun', ['x', 'tsc', '--noEmit', '-p', join(tmp, 'tsconfig.tsc.json')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    if (tsc.status !== 0) {
      console.error('extract-compose-proof: typecheck failed')
      console.error(tsc.stdout)
      console.error(tsc.stderr)
      process.exit(1)
    }
    const runFile = join(ROOT, 'apps/example-api/.extract-compose-proof-run.ts')
    writeFileSync(runFile, PROOF_APP)
    const run = spawnSync('bun', [runFile], {
      cwd: join(ROOT, 'apps/example-api'),
      encoding: 'utf8',
      env: { ...process.env, KIT_MIG_DIR: MIG_DIR },
    })
    rmSync(runFile, { force: true })
    if (run.status !== 0) {
      console.error('extract-compose-proof: runtime proof failed')
      console.error(run.stdout)
      console.error(run.stderr)
      process.exit(1)
    }

    console.log('extract-compose-proof: OK (typecheck + session/key credentials and org scope)')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

await main().catch((err) => {
  console.error('extract-compose-proof:', err instanceof Error ? err.message : err)
  process.exit(1)
})
