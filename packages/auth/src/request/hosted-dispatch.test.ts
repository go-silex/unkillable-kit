import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { validator } from 'hono/validator'
import { describe, expect, it, vi } from 'vitest'
import { authorizeHostedPrincipal, type HostedPrincipal } from '../snapshot'
import { setup, type TestEnv } from './core.fixture'
import { createHostedDispatch } from './hosted-dispatch'

const OUTER = 'https://api.example.test/mcp'
const GRANT = { userId: 'actor', grantId: 'grant-private', clientId: 'client-private' }

async function grant(f: ReturnType<typeof setup>) {
  const result = await authorizeHostedPrincipal({ db: f.db, principal: GRANT })
  if (result.status !== 'allowed') throw new Error('Fixture hosted principal denied')
  f.db.batch.mockClear()
  return result
}

function invoke(
  f: ReturnType<typeof setup>,
  admission: Awaited<ReturnType<typeof grant>>,
  headers?: HeadersInit,
) {
  return createHostedDispatch({
    app: f.app,
    authorization: f.authorization,
    outer: new Request(OUTER, { headers }),
    admission,
  })
}

describe('hosted dispatch', () => {
  it.each([
    'undeclared',
    'unguarded',
    'mis-wired',
    'wrong instance',
    'shared path',
    'shared function',
    'identified terminal ALL',
    'identified undeclared ALL before declared GET',
    'reused function in undeclared ALL before guard',
  ] as const)('%s preflight refusal enters no handler and does not load', async (mode) => {
    const entered = vi.fn(() => new Response('entered'))
    const fakeMiddleware: MiddlewareHandler<TestEnv> = async () => entered()
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    switch (mode) {
      case 'undeclared':
        app.get('/op', auth.requireAuth, entered)
        break
      case 'unguarded':
        auth.hosted(app, () => app.get('/op', entered))
        break
      case 'mis-wired':
        auth.hosted(app, () => app.get('/op', auth.requireAuth, entered, auth.requireOrgContext()))
        break
      case 'wrong instance':
        auth.hosted(app, () => app.get('/op', setup().authorization.requireAuth, entered))
        break
      case 'shared path':
        auth.hosted(app, () => app.get('/op', auth.requireAuth, entered))
        app.get('/op', () => entered())
        break
      case 'shared function':
        auth.hosted(app, () => app.get('/other', auth.requireAuth, entered))
        app.get('/op', auth.requireAuth, entered)
        break
      case 'identified terminal ALL':
        app.use('/op', auth.requireAuth)
        auth.middleware(app, () => app.all('/op', fakeMiddleware))
        break
      case 'identified undeclared ALL before declared GET':
        app.use('/op', auth.requireAuth)
        app.all('/op', fakeMiddleware)
        auth.hosted(app, () => app.get('/op', entered))
        break
      case 'reused function in undeclared ALL before guard':
        auth.middleware(app, () => app.use('/elsewhere', fakeMiddleware))
        app.all('/op', fakeMiddleware)
        auth.hosted(app, () => app.get('/op', auth.requireOrgContext(), entered))
        break
    }
    const result = await invoke(f, admission).fetch({
      method: 'GET',
      path: '/op',
      ...(mode === 'mis-wired' || mode === 'reused function in undeclared ALL before guard'
        ? { organizationId: 'chosen' }
        : {}),
    })
    expect(result.status).toBe(403)
    expect(await result.text()).not.toContain(GRANT.grantId)
    expect(db.batch).not.toHaveBeenCalled()
    expect(entered).not.toHaveBeenCalled()
  })

  it('does not transfer declarations to another app that shares the router', async () => {
    const f = setup()
    const { app, authorization, db } = f
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    authorization.hosted(app, () => app.get('/op', authorization.requireAuth, entered))
    const alias = new Hono<TestEnv>({ router: app.router })
    const dispatch = createHostedDispatch({
      app: alias,
      authorization,
      admission,
      outer: new Request(OUTER),
    })
    expect((await dispatch.fetch({ method: 'GET', path: '/op' })).status).toBe(403)
    expect(entered).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('dispatches Org-free then Org-bound to a mounted guarded route, once per dispatch', async () => {
    const identified: MiddlewareHandler<TestEnv> = (_c, next) => next()
    const f = setup({ modules: true })
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    auth.middleware(app, () => app.use('*', identified))
    auth.hosted(app, () =>
      app.get('/which-org', auth.requireAuth, (c) => {
        expect(c.req.header('authorization')).toBeUndefined()
        expect(c.req.header('cookie')).toBeUndefined()
        expect(c.req.header('x-org-id')).toBeUndefined()
        expect(auth.view(c)).toEqual({
          identity: {
            method: 'mcp',
            subject: 'actor',
            grantId: GRANT.grantId,
            clientId: GRANT.clientId,
          },
        })
        return c.json({ id: 'chosen' })
      }),
    )
    const child = new Hono<TestEnv>()
    child.onError((error) => {
      throw error
    })
    child.get(
      '/:orgId',
      auth.requireModule('calendar'),
      validator('query', (value) => value),
      (c) => {
        expect(auth.view(c).organization?.modules).not.toBe('disabled')
        return c.json({
          id: auth.view(c).organization?.id,
          subject: c.get('subject'),
          filter: c.req.valid('query').filter,
        })
      },
    )
    auth.hosted(app, () => app.route('/org', child))
    const capability = invoke(f, admission, {
      Authorization: 'Bearer outer-secret',
      Cookie: 'outer-cookie',
    })
    const result = await capability.fetch({ method: 'GET', path: '/which-org' })
    expect(result.status).toBe(200)
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(db.prepare.mock.calls.at(-1)?.[0]).not.toContain('membership')
    const { id } = (await result.json()) as { id: string }
    const scoped = await capability.fetch({
      method: 'GET',
      path: '/org/chosen',
      organizationId: id,
      query: { filter: 'x' },
    })
    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toEqual({ id, subject: 'actor', filter: 'x' })
    expect(db.batch).toHaveBeenCalledTimes(2)
    expect(db.withSession).not.toHaveBeenCalled()
  })

  it.each(['role', 'capability'] as const)(
    'accepts an Org-bound route with only its Org %s guard',
    async (kind) => {
      const f = setup()
      const { app, authorization: auth, db } = f
      const admission = await grant(f)
      const guard =
        kind === 'role' ? auth.requireOrgRole('reader') : auth.requireOrgCapability('read')
      auth.hosted(app, () =>
        app.get('/org/:orgId', guard, (c) => c.json({ id: auth.view(c).organization?.id })),
      )
      const result = await invoke(f, admission).fetch({
        method: 'GET',
        path: '/org/chosen',
        organizationId: 'chosen',
      })
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ id: 'chosen' })
      expect(db.batch).toHaveBeenCalledTimes(1)
    },
  )

  it('requires declared Platform Role opt-in and never bypasses Organization membership', async () => {
    const f = setup()
    const { app, authorization: auth, sqlite } = f
    sqlite.exec(
      "INSERT INTO user_platform_roles VALUES ('actor','super_admin'); DELETE FROM member WHERE id='mo'",
    )
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    auth.hosted(app, () => app.get('/role-off', auth.requirePlatformRole('super_admin'), entered))
    auth.hosted(
      app,
      () =>
        app.get('/role-on', auth.requirePlatformRole('super_admin'), (c) =>
          c.text(String(auth.view(c).platformRole)),
        ),
      { platformRole: true },
    )
    auth.hosted(
      app,
      () => app.get('/org/:orgId', auth.requireOrgContext({ allowSuperAdmin: true }), entered),
      { platformRole: true },
    )
    const dispatch = invoke(f, admission)
    expect((await dispatch.fetch({ method: 'GET', path: '/role-off' })).status).toBe(403)
    expect(await (await dispatch.fetch({ method: 'GET', path: '/role-on' })).text()).toBe(
      'super_admin',
    )
    expect(
      (await dispatch.fetch({ method: 'GET', path: '/org/other', organizationId: 'other' })).status,
    ).toBe(404)
    expect(entered).not.toHaveBeenCalled()
    sqlite.exec("UPDATE user SET disabled=1 WHERE id='actor'")
    expect((await dispatch.fetch({ method: 'GET', path: '/role-on' })).status).toBe(401)
  })

  it('does not let an Org-free call select an Org; rejects designation conflicts before a scoped read', async () => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    app.use('/org/*', auth.requireAuth)
    auth.hosted(app, () => app.get('/org/:orgId', auth.requireOrgContext(), entered))
    const dispatch = invoke(f, admission)
    db.prepare.mockClear()
    expect((await dispatch.fetch({ method: 'GET', path: '/org/chosen' })).status).toBe(403)
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(db.prepare.mock.calls.every(([sql]) => !sql.includes('membership'))).toBe(true)
    expect(
      (await dispatch.fetch({ method: 'GET', path: '/org/other', organizationId: 'chosen' }))
        .status,
    ).toBe(403)
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(entered).not.toHaveBeenCalled()
  })

  it('never falls back after a clone, replay, closure or forged admission', async () => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    let raw: Request | undefined
    const entered = vi.fn()
    auth.hosted(app, () =>
      app.get('/op', auth.requireAuth, (c) => {
        raw = c.req.raw
        entered()
        return c.text('entered')
      }),
    )
    const dispatch = invoke(f, admission)
    const op = { method: 'GET', path: '/op' }
    expect((await dispatch.fetch(op)).status).toBe(200)
    expect((await app.fetch(raw!)).status).toBe(401)
    expect((await app.fetch(raw!.clone())).status).toBe(401)
    dispatch.close()
    expect((await dispatch.fetch(op)).status).toBe(401)
    expect((await app.fetch(raw!)).status).toBe(401)
    const forged = invoke(f, {
      status: 'allowed',
      principal: { ...admission.principal } as HostedPrincipal,
    })
    expect((await forged.fetch(op)).status).toBe(401)
    expect(entered).toHaveBeenCalledTimes(1)
    expect(db.batch).toHaveBeenCalledTimes(1)
  })

  it('shares an eight-slot cap concurrently and charges preflight refusals but not invalid designations', async () => {
    const f = setup()
    const admission = await grant(f)
    const { app, authorization: auth, db } = f
    let release: () => void = () => {
      throw new Error('Deferred gate did not initialise')
    }
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = vi.fn()
    auth.hosted(app, () =>
      app.get('/op', auth.requireAuth, async (c) => {
        entered()
        await gate
        return c.text('entered')
      }),
    )
    const dispatch = invoke(f, admission)
    const op = { method: 'GET', path: '/op' }
    expect((await dispatch.fetch({ ...op, organizationId: '' })).status).toBe(400)
    expect((await dispatch.fetch({ ...op, path: '/not-declared' })).status).toBe(403)
    const pending = Array.from({ length: 9 }, () => dispatch.fetch(op))
    expect((await pending[8]!).status).toBe(429)
    release()
    expect((await Promise.all(pending)).map((res) => res.status)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 429, 429,
    ])
    expect(entered).toHaveBeenCalledTimes(7)
    expect(db.batch).toHaveBeenCalledTimes(7)
  })

  it('constrains only Org-bound dispatches using exact, nonrepeated outer selectors', async () => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    auth.hosted(app, () => {
      app.get('/op', auth.requireAuth, (c) => c.text('entered'))
      app.get('/org/:orgId', auth.requireOrgContext(), (c) => c.text('entered'))
    })
    const outer = new Headers([
      ['x-org-id', 'chosen'],
      ['X-Org-Id', 'chosen'],
    ])
    const free = { method: 'GET', path: '/op' }
    const bound = { method: 'GET', path: '/org/chosen', organizationId: 'chosen' }
    const repeated = invoke(f, admission, outer)
    expect((await repeated.fetch(free)).status).toBe(200)
    expect((await repeated.fetch(bound)).status).toBe(400)
    expect((await invoke(f, admission, { 'x-org-id': 'CHOSEN' }).fetch(bound)).status).toBe(403)
    expect((await invoke(f, admission, { 'x-org-id': 'chosen' }).fetch(bound)).status).toBe(200)
    expect(db.batch).toHaveBeenCalledTimes(2)
  })

  it('rechecks the actual registrations inside the guard', async () => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    auth.hosted(app, () => app.get('/declared', auth.requireAuth, entered))
    app.get('/undeclared', auth.requireAuth, entered)
    const real = app.router.match('GET', '/declared')
    const different = app.router.match('GET', '/undeclared')
    const spy = vi
      .spyOn(app.router, 'match')
      .mockReturnValueOnce(real)
      .mockReturnValueOnce(different)
    try {
      expect((await invoke(f, admission).fetch({ method: 'GET', path: '/declared' })).status).toBe(
        403,
      )
      expect(db.batch).not.toHaveBeenCalled()
      expect(entered).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('rechecks declared Product headers against the registrations inside the guard', async () => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    auth.hosted(app, () => app.get('/declared', auth.requireAuth, entered), {
      headers: ['Idempotency-Key'],
    })
    auth.hosted(app, () => app.get('/other', auth.requireAuth, entered))
    const real = app.router.match('GET', '/declared')
    const different = app.router.match('GET', '/other')
    const spy = vi
      .spyOn(app.router, 'match')
      .mockReturnValueOnce(real)
      .mockReturnValueOnce(different)
    try {
      const result = await invoke(f, admission).fetch({
        method: 'GET',
        path: '/declared',
        headers: { 'Idempotency-Key': 'once' },
      })
      expect(result.status).toBe(403)
      expect(db.batch).not.toHaveBeenCalled()
      expect(entered).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('carries exactly the Product headers every matched handler declares', async () => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    auth.hosted(
      app,
      () =>
        app.post('/notes', auth.requireAuth, (c) =>
          c.json({
            key: c.req.header('idempotency-key'),
            subject: c.req.header('x-expected-subject'),
            cookie: c.req.header('cookie') ?? null,
            authorization: c.req.header('authorization') ?? null,
            org: c.req.header('x-org-id') ?? null,
            type: c.req.header('content-type'),
          }),
        ),
      { headers: ['Idempotency-Key', 'x-expected-subject'] },
    )
    auth.hosted(app, () => app.post('/shared', auth.requireAuth, async (_c, next) => next()), {
      headers: ['Idempotency-Key'],
    })
    auth.hosted(app, () => app.post('/shared', entered))
    const dispatch = invoke(f, admission, { Cookie: 'outer-cookie' })
    const accepted = await dispatch.fetch({
      method: 'POST',
      path: '/notes',
      body: {},
      headers: { 'IDEMPOTENCY-KEY': 'k 1', 'X-Expected-Subject': 'actor' },
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      key: 'k 1',
      subject: 'actor',
      cookie: null,
      authorization: null,
      org: null,
      type: 'application/json',
    })
    expect(db.batch).toHaveBeenCalledTimes(1)
    for (const headers of [
      { 'X-Other': 'value' },
      { Cookie: 'chosen-cookie' },
      { Authorization: 'Bearer chosen-token' },
      { 'X-Org-Id': 'chosen' },
      { Host: 'elsewhere.example.test' },
      { 'Content-Type': 'text/plain' },
    ] as Record<string, string>[]) {
      const refused = await dispatch.fetch({ method: 'POST', path: '/notes', body: {}, headers })
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({
        error: { message: 'Hosted header not declared' },
      })
    }
    // A capability has eight slots; the dispatches above took seven.
    const fresh = invoke(f, admission)
    const shared = { method: 'POST', path: '/shared' }
    expect((await fresh.fetch(shared)).status).toBe(200)
    const narrowed = await fresh.fetch({ ...shared, headers: { 'Idempotency-Key': 'k' } })
    expect(narrowed.status).toBe(403)
    expect(await narrowed.json()).toMatchObject({
      error: { message: 'Hosted header not declared' },
    })
    expect(entered).toHaveBeenCalledTimes(1)
    expect(db.batch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a non-string value', { 'Idempotency-Key': 1 }],
    ['a repeated name', { 'Idempotency-Key': 'a', 'idempotency-key': 'b' }],
    ['a line break', { 'Idempotency-Key': 'a\r\nCookie: chosen' }],
    ['a value Fetch would trim', { 'Idempotency-Key': ' a' }],
    ['an invalid name', { 'Idempotency Key': 'a' }],
    ['a non-object', ['Idempotency-Key', 'a']],
  ])('refuses %s as an invalid operation without taking a slot', async (_name, headers) => {
    const f = setup()
    const { app, authorization: auth, db } = f
    const admission = await grant(f)
    const entered = vi.fn(() => new Response('entered'))
    auth.hosted(app, () => app.get('/op', auth.requireAuth, entered), {
      headers: ['Idempotency-Key'],
    })
    const dispatch = createHostedDispatch({
      app,
      authorization: auth,
      outer: new Request(OUTER),
      admission,
      limit: 1,
    })
    const op = { method: 'GET', path: '/op' }
    const refused = await dispatch.fetch({
      ...op,
      headers: headers as unknown as Record<string, string>,
    })
    expect(refused.status).toBe(400)
    expect(entered).not.toHaveBeenCalled()
    expect((await dispatch.fetch(op)).status).toBe(200)
    expect(db.batch).toHaveBeenCalledTimes(1)
  })

  it.each([
    'Authorization',
    'cookie',
    'X-Org-Id',
    'Host',
    'Connection',
    'Transfer-Encoding',
    'Content-Type',
    'Origin',
    'Proxy-Authorization',
    'Sec-Fetch-Site',
    'CF-Connecting-IP',
    'X-Forwarded-For',
    'Idempotency Key',
    '',
  ])('refuses to declare %j for a hosted operation', (name) => {
    const { app, authorization: auth } = setup()
    const register = vi.fn()
    expect(() => auth.hosted(app, register, { headers: [name] })).toThrow(TypeError)
    expect(register).not.toHaveBeenCalled()
  })

  it('appends every value of a repeated query key in order', async () => {
    const f = setup()
    const { app, authorization: auth } = f
    const admission = await grant(f)
    auth.hosted(app, () =>
      app.get('/search', auth.requireAuth, (c) =>
        c.json({
          tags: c.req.queries('tag'),
          one: c.req.query('one'),
          none: c.req.queries('none') ?? null,
        }),
      ),
    )
    const dispatch = invoke(f, admission)
    const result = await dispatch.fetch({
      method: 'GET',
      path: '/search',
      query: { tag: ['b', 'a', 'b'], one: 'x', none: [] },
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ tags: ['b', 'a', 'b'], one: 'x', none: null })
    for (const query of [{ tag: [1] }, { tag: { a: 'b' } }, 'tag=a']) {
      const refused = await dispatch.fetch({
        method: 'GET',
        path: '/search',
        query: query as unknown as Record<string, string>,
      })
      expect(refused.status).toBe(400)
    }
  })
})
