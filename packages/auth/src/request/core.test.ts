import { Hono, type MiddlewareHandler } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { originGuard } from '../origin-guard'
import { resolveRequestSession } from '../snapshot'
import { KEY, setup, type TestEnv } from './core.fixture'
import type { AdmittedView } from './request-authorization'
import type { ImpersonationPolicy } from './request-policy'

const business = { kind: 'business', modules: ['calendar'], op: 'read' } as const

function impersonation(
  overrides: Partial<ImpersonationPolicy<TestEnv>> = {},
): ImpersonationPolicy<TestEnv> {
  return {
    operation: ({ path }) => (path === '/recover' ? { kind: 'recovery' } : business),
    fence: (c) => c.req.header('x-impersonation-id'),
    audit: async () => {},
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

function expectUnprojected(onError: ReturnType<typeof setup>['onError']) {
  expect(onError.mock.lastCall?.slice(1)).toEqual([{}, undefined])
}

describe('request authorization core', () => {
  it('reads at the first guard, memoises and publishes only admitted stages from the primary', async () => {
    const { app, authorization: auth, db, browser, auth: issuer } = setup({ modules: true })
    const seen: AdmittedView[] = []
    app.get('/public', (c) => c.json(auth.view(c)))
    app.get(
      '/org/:orgId',
      auth.requireAuth,
      async (c, next) => {
        seen.push(auth.view(c))
        expect((await auth.session(c))?.email).toBe('actor@example.test')
        await next()
      },
      auth.requireOrgContext(),
      auth.requireModule('calendar', 'write'),
      (c) => {
        const view = auth.view(c)
        seen.push(view)
        return c.json({ subject: c.get('subject'), orgId: c.get('orgId') })
      },
    )
    expect(await (await app.request('/public', { headers: browser })).json()).toEqual({})
    expect(db.batch).not.toHaveBeenCalled()
    const response = await app.request('/org/chosen', { headers: browser })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ subject: 'actor', orgId: 'chosen' })
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(db.withSession).not.toHaveBeenCalled()
    expect(issuer.api.getSession).not.toHaveBeenCalled()
    expect(seen[0]).toEqual({
      identity: { method: 'session', subject: 'actor', sessionId: 'session-id' },
      platformRole: null,
    })
    expect(seen[1]?.organization).toMatchObject({
      id: 'chosen',
      kind: 'client',
      status: 'active',
      role: 'member',
      bypass: false,
    })
    const modules = seen[1]?.organization?.modules
    expect(modules && modules !== 'disabled' && Array.from(modules.entries())).toEqual([
      ['calendar', { available: true, access: 'write' }],
    ])
    expect(Object.isFrozen(seen[1])).toBe(true)
    expect(Object.isFrozen(seen[1]?.identity)).toBe(true)
    expect(Object.isFrozen(modules)).toBe(true)
    if (modules && modules !== 'disabled') {
      expect(Object.isFrozen(modules.get('calendar'))).toBe(true)
      modules.forEach((_, __, map) => {
        expect(map).not.toHaveProperty('set')
      })
    }
  })

  it('shares a concurrent failed load and does not dispatch or project', async () => {
    const { app, authorization: auth, db, browser, onError } = setup()
    const entered = vi.fn()
    const failures: unknown[] = []
    db.batch.mockRejectedValueOnce(new Error('private driver diagnostic'))
    app.get('/concurrent', async (c) => {
      const results = await Promise.allSettled([auth.session(c), auth.session(c)])
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length) throw failures[0]
      entered()
      return c.text('handler')
    })
    const response = await app.request('/concurrent', { headers: browser })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private driver diagnostic')
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toBe(failures[1])
    expect(entered).not.toHaveBeenCalled()
    expectUnprojected(onError)
  })

  it.each(['unchanged', 'Platform Role', 'scope', 'delegation', 'revoked'] as const)(
    'authenticates twice only when the first guard cannot see the selection (%s)',
    async (changes) => {
      const change: MiddlewareHandler<TestEnv> = async (_c, next) => {
        if (changes === 'Platform Role')
          sqlite.exec("INSERT INTO user_platform_roles VALUES ('actor','staff')")
        if (changes === 'scope') sqlite.exec("UPDATE api_keys SET scopes = 'write'")
        if (changes === 'delegation') sqlite.exec('DELETE FROM impersonation_sessions')
        if (changes === 'revoked') sqlite.exec('DELETE FROM session')
        await next()
      }
      const audit = vi.fn(async () => {})
      const {
        app,
        authorization: auth,
        db,
        browser,
        apiKey,
        attachDelegation,
        sqlite,
        onError,
      } = setup({
        keyScope: () => true,
        middleware: [change],
        ...(changes === 'delegation'
          ? {
              impersonation: impersonation({
                operation: () => ({ kind: 'business', modules: [], op: 'read' }),
                audit,
              }),
            }
          : {}),
      })
      const entered = vi.fn()
      let headers: HeadersInit = browser
      if (changes === 'scope') headers = (await apiKey()).headers
      if (changes === 'delegation') {
        attachDelegation()
        headers = { ...browser, 'x-impersonation-id': 'delegation' }
      }
      app.use('/two/*', auth.requireAuth, change)
      app.get('/two/:orgId', auth.requireOrgContext(), auth.requireOrgRole('reader'), (c) => {
        entered()
        return c.text('ok')
      })
      const response = await app.request('/two/chosen', { headers })
      expect(response.status).toBe(
        { unchanged: 200, 'Platform Role': 503, scope: 503, delegation: 503, revoked: 401 }[
          changes
        ],
      )
      expect(db.batch).toHaveBeenCalledTimes(2)
      expect(entered).toHaveBeenCalledTimes(Number(changes === 'unchanged'))
      expect(audit).toHaveBeenCalledTimes(Number(changes === 'delegation'))
      if (changes !== 'unchanged')
        expect(onError.mock.lastCall?.[1]).not.toHaveProperty('organization')
    },
  )

  it('binds exactly and gives authentication precedence over malformed or conflicting selectors', async () => {
    const { app, authorization: auth, db, browser } = setup()
    app.get('/org/:orgId', auth.requireOrgContext(), (c) => c.text(c.get('orgId') ?? 'none'))
    app.get('/server/:orgId?', auth.requireOrgContext({ organizationId: () => 'chosen' }), (c) =>
      c.text(c.get('orgId') ?? 'none'),
    )
    const request = (path: string, x?: string) =>
      app.request(path, { headers: { ...browser, ...(x === undefined ? {} : { 'x-org-id': x }) } })
    const headers = new Headers(browser)
    headers.append('X-Org-Id', 'chosen')
    headers.append('x-org-id', 'chosen')
    expect((await app.request('/org/chosen', { headers })).status).toBe(400)
    expect((await request('/org/chosen', 'other')).status).toBe(403)
    expect((await request('/server/other')).status).toBe(403)
    expect((await request('/server', 'other')).status).toBe(403)
    expect(db.prepare.mock.calls.every(([sql]) => !sql.includes('membership'))).toBe(true)
    expect((await app.request('/org/chosen', { headers: { 'X-Org-Id': 'a,b' } })).status).toBe(401)
    expect(await (await request('/org/chosen', '')).text()).toBe('chosen')
    expect(await (await request('/server')).text()).toBe('chosen')
    expect(await (await request('/server/chosen', 'chosen')).text()).toBe('chosen')
  })

  it('does not switch Organizations between guarded prefix and endpoint registrations', async () => {
    const { app, authorization: auth, db, browser } = setup()
    app.use('/prefix/*', auth.requireOrgContext({ organizationId: () => 'chosen' }))
    app.get('/prefix/:orgId', auth.requireOrgContext(), (c) => c.text('entered'))
    expect((await app.request('/prefix/other', { headers: browser })).status).toBe(403)
    expect(db.batch).toHaveBeenCalledTimes(1)
  })

  it('refuses case, whitespace, Unicode-normalization and storage-type lookalikes', async () => {
    const { app, authorization: auth, sqlite, browser } = setup({ modules: true })
    sqlite.exec(
      "INSERT INTO organization VALUES ('café', 'client', 'active'), ('42', 'client', 'active'); INSERT INTO member VALUES ('unicode', 'café', 'actor', 'reader'), ('number', '42', 42, 'reader')",
    )
    app.get('/org/:orgId', auth.requireOrgContext(), (c) => c.text('entered'))
    app.get('/grant/:orgId', auth.requireModule('calendar', 'write'), (c) => c.text('entered'))
    const request = (path: string) => app.request(path, { headers: browser })
    expect((await request('/org/chosen')).status).toBe(200)
    expect((await request('/org/CHOSEN')).status).toBe(404)
    expect((await request('/org/%20chosen')).status).toBe(400)
    expect((await request('/org/caf%C3%A9')).status).toBe(200)
    expect((await request('/org/cafe%CC%81')).status).toBe(404)
    sqlite.exec(
      "INSERT INTO user VALUES ('42', 'Number lookalike', 'lookalike@example.test', 0); UPDATE session SET user_id = '42'",
    )
    expect((await request('/org/42')).status).toBe(404)
    sqlite.exec("UPDATE session SET user_id='ACTOR'")
    expect((await request('/org/chosen')).status).toBe(401)
    sqlite.exec("UPDATE session SET user_id='actor'; UPDATE member SET role='MEMBER' WHERE id='ma'")
    expect((await request('/grant/chosen')).status).toBe(403)
  })

  it('observes revocation, suspension, membership removal and role-grant removal on the next request', async () => {
    const {
      app,
      authorization: auth,
      sqlite,
      browser,
      apiKey,
    } = setup({ modules: true, keyScope: () => true })
    const key = await apiKey()
    app.get('/org/:orgId', auth.requireModule('calendar'), (c) => c.text('entered'))
    const run = async (headers: HeadersInit = browser) =>
      (await app.request('/org/chosen', { headers })).status
    expect(await run(key.headers)).toBe(200)
    sqlite.exec('UPDATE api_keys SET revoked_at=1')
    expect(await run(key.headers)).toBe(401)
    expect(await run()).toBe(200)
    sqlite.exec('DELETE FROM organization_role_module_grants')
    expect(await run()).toBe(403)
    sqlite.exec("UPDATE organization SET status='suspended' WHERE id='chosen'")
    expect(await run()).toBe(403)
    sqlite.exec("DELETE FROM member WHERE id='ma'")
    expect(await run()).toBe(404)
    sqlite.exec("UPDATE user SET disabled=1 WHERE id='actor'")
    expect(await run()).toBe(401)
    sqlite.exec('UPDATE user SET disabled=0; DELETE FROM session')
    expect(await run()).toBe(401)
  })

  it('keeps RBAC SQL opt-in and fails closed on missing schema or duplicate required rows', async () => {
    const { app, authorization: auth, sqlite, browser, db } = setup()
    sqlite.exec('DROP TABLE organization_roles; DROP TABLE organization_role_module_grants')
    app.get('/org/:orgId', auth.requireOrgContext(), (c) =>
      c.text(String(auth.view(c).organization?.modules)),
    )
    expect(() => auth.requireModule('calendar')).toThrow('modules: true')
    expect(await (await app.request('/org/chosen', { headers: browser })).text()).toBe('disabled')
    expect(db.prepare.mock.calls.every(([sql]) => !sql.includes('organization_roles'))).toBe(true)
    sqlite.exec("INSERT INTO member VALUES ('duplicate','chosen','actor','reader')")
    expect((await app.request('/org/chosen', { headers: browser })).status).toBe(503)
    const enabled = setup({ modules: true })
    enabled.app.get('/org/:orgId', enabled.authorization.requireOrgContext(), (c) =>
      c.text('entered'),
    )
    enabled.sqlite.exec('DROP TABLE organization_roles')
    expect((await enabled.app.request('/org/chosen', { headers: enabled.browser })).status).toBe(
      503,
    )
  })

  it('honors platform and Organization guards and the audited break-glass ceiling', async () => {
    const { app, authorization: auth, sqlite, browser } = setup({ modules: true })
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    sqlite.exec(
      "INSERT INTO user_platform_roles VALUES ('actor','super_admin'); DELETE FROM member WHERE id='mo'",
    )
    app.get('/platform', auth.requirePlatformRole('super_admin'), (c) => c.text('entered'))
    app.get(
      '/read/:orgId',
      auth.requireOrgContext({ allowSuperAdmin: true }),
      auth.requireOrgRole('admin'),
      (c) => c.text('entered'),
    )
    app.post('/write/:orgId', auth.requireOrgContext({ allowSuperAdmin: true }), (c) =>
      c.text('entered'),
    )
    app.delete(
      '/write/:orgId',
      auth.requireOrgContext({ allowSuperAdminWrite: true }),
      auth.requireOrgCapability('delete_org'),
      (c) => c.text('entered'),
    )
    app.get(
      '/module/:orgId',
      auth.requireOrgContext({ allowSuperAdmin: true }),
      auth.requireModule('calendar'),
      (c) => c.text('entered'),
    )
    const run = async (path: string, method = 'GET') =>
      (await app.request(path, { method, headers: browser })).status
    expect(await run('/platform')).toBe(200)
    expect(await run('/read/other')).toBe(200)
    expect(await run('/write/other', 'POST')).toBe(403)
    expect(await run('/write/other', 'DELETE')).toBe(403)
    expect(await run('/module/other')).toBe(404)
    expect(log.mock.calls[0]?.[0]).toContain('super_admin_org_bypass')
  })

  it.each([false, true])(
    'protects the Better Auth mount (overlapping sign-out terminal=%s)',
    async (withOverlap) => {
      const f = setup({
        impersonation: impersonation({
          operation: ({ method, path, routes }) => {
            if (path === '/api/auth/session') return { kind: 'recovery' }
            return method === 'POST' &&
              path === '/api/auth/sign-out' &&
              routes.length > 0 &&
              routes.every((route) => route.path === '/api/auth/*')
              ? { kind: 'recovery' }
              : null
          },
        }),
      })
      const { app, authorization: auth, browser, db } = f
      const handler = vi.fn(() => new Response('entered'))
      app.all('/api/auth/*', auth.betterAuthMount, (c) => {
        expect(auth.view(c)).toEqual({})
        return handler()
      })
      const overlap = vi.fn(() => new Response('overlapping terminal'))
      if (withOverlap) app.all('/api/auth/sign-out', overlap)
      expect((await app.request('/api/auth/sign-in', { method: 'POST' })).status).toBe(200)
      expect(db.batch).not.toHaveBeenCalled()
      expect(
        (await app.request('/api/auth/session', { headers: (await f.apiKey()).headers })).status,
      ).toBe(403)
      expect(
        (await app.request('/api/auth/session', { headers: { Authorization: 'Bearer invalid' } }))
          .status,
      ).toBe(401)
      expect(
        (await app.request('/api/auth/session', { headers: { 'x-impersonation-id': 'stale' } }))
          .status,
      ).toBe(409)
      f.attachDelegation()
      expect(
        (
          await app.request('/api/auth/session', {
            headers: { ...browser, 'x-impersonation-id': 'delegation' },
          })
        ).status,
      ).toBe(403)
      expect(
        (await app.request('/api/auth/sign-out', { method: 'POST', headers: browser })).status,
      ).toBe(withOverlap ? 409 : 200)
      expect(
        (
          await app.request('/api/auth/sign-out', {
            method: 'POST',
            headers: { ...browser, Authorization: 'Bearer' },
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await app.request('/api/auth/sign-out', {
            method: 'POST',
            headers: { ...browser, 'x-impersonation-id': 'delegation' },
          })
        ).status,
      ).toBe(withOverlap ? 403 : 200)
      expect(overlap).not.toHaveBeenCalled()
      expect(handler).toHaveBeenCalledTimes(withOverlap ? 1 : 3)
      expect(
        await resolveRequestSession({ db, headers: new Headers(browser), auth: f.auth }),
      ).toMatchObject({ subject: 'actor' })
    },
  )

  it('leaves native browser requests to Better Auth when impersonation is disabled', async () => {
    const { app, authorization: auth, browser, db } = setup()
    app.all('/api/auth/*', auth.betterAuthMount, (c) => c.json(auth.view(c)))
    const response = await app.request('/api/auth/session', {
      headers: { ...browser, 'x-org-id': 'conflict,invalid' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('projects only the admitted browser actor permissions without reloading them', async () => {
    const f = setup({ impersonation: impersonation(), keyScope: () => true })
    const { app, authorization: auth, browser, db, sqlite } = f
    app.get('/recover', auth.requireAuth, (c) => {
      const view = auth.view(c)
      if (view.impersonationPermissions)
        expect(Object.isFrozen(view.impersonationPermissions)).toBe(true)
      return c.json(view)
    })
    f.attachDelegation()
    sqlite.exec("DELETE FROM impersonation_sessions; DELETE FROM member WHERE id='ma'")
    const browserView = async () => (await app.request('/recover', { headers: browser })).json()
    expect(await browserView()).toMatchObject({
      impersonationPermissions: { read: true, write: false },
    })
    expect(db.batch).toHaveBeenCalledTimes(1)
    sqlite.exec(
      "INSERT INTO impersonation_sessions VALUES ('delegation','session-id','actor','target','chosen','read',1)",
    )
    expect(await browserView()).toMatchObject({
      delegation: { recovery: true, actorProfile: null, targetProfile: null },
      impersonationPermissions: { read: true, write: false },
    })
    expect(db.batch).toHaveBeenCalledTimes(2)
    sqlite.exec(
      "DELETE FROM impersonation_sessions; INSERT INTO member VALUES ('ma','chosen','actor','reader')",
    )
    const { headers } = await f.apiKey()
    const response = await app.request('/recover', { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('impersonationPermissions')
  })

  it('uses the represented role for business and grants no Platform/Org authority in recovery', async () => {
    const audit = vi.fn(async () => {})
    const f = setup({ modules: true, impersonation: impersonation({ audit }) })
    const { app, authorization: auth, browser } = f
    f.attachDelegation()
    app.get('/read/:orgId', auth.requireModule('calendar'), (c) => {
      const view = auth.view(c)
      expect(view.platformRole).toBeUndefined()
      expect(view.delegation).toMatchObject({
        actor: { subject: 'actor' },
        recovery: false,
        mode: 'read',
        startedAt: 1,
      })
      expect(Object.isFrozen(view.delegation?.targetProfile)).toBe(true)
      return c.json({ subject: c.get('subject'), role: view.organization?.role })
    })
    app.get('/write/:orgId', auth.requireModule('calendar', 'write'), (c) => c.text('entered'))
    app.get('/recover', auth.requireAuth, async (c) =>
      c.json({ view: auth.view(c), session: await auth.session(c) }),
    )
    const fenced = { ...browser, 'x-impersonation-id': 'delegation' }
    expect(await (await app.request('/read/chosen', { headers: fenced })).json()).toEqual({
      subject: 'target',
      role: 'reader',
    })
    expect((await app.request('/write/chosen', { headers: fenced })).status).toBe(403)
    expect(audit).toHaveBeenCalledTimes(2)
    expect(await (await app.request('/recover', { headers: browser })).json()).toMatchObject({
      session: null,
      view: { delegation: { recovery: true } },
    })
  })
})

describe('operation hooks', () => {
  it.each([false, true])(
    'checks all .all fall-through terminals once, regardless of guard placement (prefix=%s)',
    async (prefix) => {
      const allow = vi.fn(
        (route: { method: string }, scopes: readonly string[]) =>
          route.method === 'GET' && scopes.includes('read'),
      )
      const identified: MiddlewareHandler<TestEnv> = (_c, next) => next()
      const f = setup({ keyScope: allow, middleware: [identified, originGuard] })
      const { app, authorization: auth } = f
      const key = await f.apiKey()
      const fallThrough = vi.fn<MiddlewareHandler<TestEnv>>((_c, next) => next())
      app.use('*', identified)
      if (prefix) app.use('/scope/*', auth.requireAuth)
      const child = new Hono<TestEnv>()
      if (prefix) {
        child.all('/unsafe', fallThrough)
        child.get('/safe', (c) => c.text('entered'))
      } else {
        child.all('/unsafe', auth.requireAuth, fallThrough)
        child.get('/safe', auth.requireAuth, (c) => c.text('entered'))
      }
      child.get('/unsafe', (c) => c.text('entered'))
      app.route('/scope', child)
      expect(
        (await app.request('/scope/safe', { method: 'HEAD', headers: key.headers })).status,
      ).toBe(200)
      expect(allow.mock.calls).toEqual([[{ method: 'GET', path: '/scope/safe' }, ['read']]])
      allow.mockClear()
      expect((await app.request('/scope/unsafe', { headers: key.headers })).status).toBe(403)
      expect(allow.mock.calls.map(([route]) => route.method)).toEqual(['ALL', 'GET'])
      expect(fallThrough).not.toHaveBeenCalled()
      allow.mockImplementation(() => true)
      expect((await app.request('/scope/unsafe', { headers: key.headers })).status).toBe(200)
      expect(fallThrough).toHaveBeenCalledTimes(1)
    },
  )

  it('does not impose planning errors for overlapping routes or a guarded prefix without an endpoint', async () => {
    const { app, authorization: auth, browser } = setup()
    app.use('/known/*', auth.requireAuth)
    app.get('/known/:orgId', auth.requireOrgContext(), (c) => c.text('param'))
    app.get('/known/fixed', auth.requireAuth, (c) => c.text('exact'))
    expect((await app.request('/known/sub/path', { headers: browser })).status).toBe(404)
    expect((await app.request('/known/sub/path')).status).toBe(401)
    expect((await app.request('/known/chosen', { headers: browser })).status).toBe(200)
    expect((await app.request('/known/fixed', { headers: browser })).status).toBe(404)
  })

  const cases: Record<
    string,
    {
      status: number
      keyDecision?: false | 'failure'
      delegation?: true
      auditFailure?: true
      sql?: string
      partial?: true
    }
  > = {
    credential: { status: 401 },
    scope: { status: 403, keyDecision: false },
    'scope failure': { status: 503, keyDecision: 'failure' },
    fence: { status: 409, delegation: true },
    organization: { status: 404, sql: "DELETE FROM member WHERE id='ma'" },
    module: { status: 403, sql: 'DELETE FROM organization_role_module_grants' },
    'audit failure': { status: 503, delegation: true, auditFailure: true },
    'partial batch': { status: 503, partial: true },
  }
  function observePrimary(db: ReturnType<typeof setup>['db'], partial?: true) {
    const primary = db.batch.getMockImplementation()!
    let raw: unknown
    db.batch.mockImplementationOnce(async (statements) => {
      raw = await primary(statements)
      if (partial && Array.isArray(raw)) return [raw[0], { success: false, error: KEY }]
      return raw
    })
    return () => raw
  }

  function arrangeRefusal(
    f: ReturnType<typeof setup>,
    reason: string,
    test: (typeof cases)[string],
    keyHeaders: HeadersInit,
  ) {
    if (test.delegation) f.attachDelegation()
    if (test.sql) f.sqlite.exec(test.sql)
    const raw = observePrimary(f.db, test.partial)
    const headers = new Headers(test.keyDecision === undefined ? f.browser : keyHeaders)
    if (reason === 'credential') headers.set('Authorization', `Bearer ${KEY}x`)
    if (test.auditFailure) headers.set('x-impersonation-id', 'delegation')
    return { headers, raw }
  }
  it.each(Object.entries(cases))(
    'sanitizes %s refusals without entering the handler or publishing a stage',
    async (reason, test) => {
      let keyDecision: boolean | 'failure' = true
      const hook = vi.fn(() => {
        if (keyDecision === 'failure') throw new Error(KEY)
        return keyDecision
      })
      const audit = vi.fn(async () => {
        if (test.auditFailure) throw new Error(KEY)
      })
      const f = setup({
        modules: true,
        keyScope: hook,
        impersonation: test.delegation ? impersonation({ audit }) : undefined,
      })
      const { app, authorization: auth, browser, onError } = f
      const key = await f.apiKey()
      const logs = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'warn'),
        vi.spyOn(console, 'info'),
        vi.spyOn(console, 'error'),
      ]
      for (const log of logs) log.mockImplementation(() => {})
      const handler = vi.fn(() => new Response('entered'))
      app.get('/private/:orgId', auth.requireModule('calendar'), handler)
      const invoke = (headers: HeadersInit = browser) => app.request('/private/chosen', { headers })
      expect((await invoke(key.headers)).status).toBe(200)
      expect((await invoke()).status).toBe(200)
      handler.mockClear()
      keyDecision = test.keyDecision ?? true
      const { headers, raw } = arrangeRefusal(f, reason, test, key.headers)
      const response = await invoke(headers)
      expect(response.status).toBe(test.status)
      expect(JSON.stringify(raw())).toContain(
        headers.has('Authorization') ? key.hash : 'actor@example.test',
      )
      const visible =
        (await response.text()) + JSON.stringify(logs.flatMap((log) => log.mock.calls))
      for (const secret of [
        KEY,
        key.hash,
        f.token,
        'actor@example.test',
        'Private Actor',
        'Private Target',
      ]) {
        expect(visible).not.toContain(secret)
      }
      expect(handler).not.toHaveBeenCalled()
      expectUnprojected(onError)
    },
  )
})
