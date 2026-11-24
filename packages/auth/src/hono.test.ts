import { inspect } from 'node:util'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { fixture, marker, path, projection } from './request/authorization-hono.fixture'
import { defineAuthorizationFact } from './snapshot'

describe('HTTP authorization facts', () => {
  it.each([
    ['unverified credential', 401, 'Unauthorized'],
    ['missing key scope', 403, 'Forbidden'],
    ['missing Module grant', 403, 'Insufficient module grant'],
    ['unavailable Module', 404, 'Module not available'],
    ['partially failed load', 503, 'Authorization unavailable'],
  ] as const)(
    'does not expose a returned Product row after %s',
    async (reason, status, message) => {
      const { app, batches, cookie, decode, failure, key, prepare, sqlite } = await fixture()
      const headers = new Headers({ cookie })
      if (reason === 'unverified credential' || reason === 'missing key scope') {
        headers.set('authorization', `Bearer ${key}`)
      }

      const admitted = await app.request(path, { headers })
      expect(admitted.status).toBe(200)
      expect(batches).toHaveLength(1)
      expect(await admitted.json()).toEqual({ label: marker })
      expect(decode).toHaveBeenCalledExactlyOnceWith([{ label: marker }])
      decode.mockClear()
      batches.length = 0

      switch (reason) {
        case 'unverified credential':
          headers.set('authorization', `Bearer ${key}invalid`)
          break
        case 'missing key scope':
          sqlite.exec("UPDATE api_keys SET scopes = 'write'")
          break
        case 'missing Module grant':
          sqlite.exec('DELETE FROM organization_role_module_grants')
          break
        case 'unavailable Module':
          sqlite.exec('UPDATE platform_modules SET available = 0')
          break
        case 'partially failed load':
          failure.partial = true
          break
      }
      const output = (['info', 'warn', 'error', 'log', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      )
      onTestFinished(() => {
        for (const spy of output) spy.mockRestore()
      })

      const refused = await app.request(path, { headers })
      expect(refused.status).toBe(status)
      expect(await refused.json()).toEqual({ message })
      expect(batches).toHaveLength(1)
      expect(batches[0]).toContainEqual({ success: true, results: [{ label: marker }] })
      for (const [sql] of prepare.mock.calls) expect(sqlite.prepare(sql).readonly).toBe(true)
      expect(decode).not.toHaveBeenCalled()
      for (const spy of output)
        expect(inspect(spy.mock.calls, { depth: null })).not.toContain(marker)
    },
  )

  it('refuses absent or malformed credentials without a fact read or cookie fallback', async () => {
    const { app, batches, cookie, decode, prepare } = await fixture()
    expect((await app.request(path)).status).toBe(401)
    const malformed = await app.request(path, {
      headers: { cookie, authorization: 'Bearer short' },
    })
    expect(malformed.status).toBe(401)
    expect(batches).toHaveLength(0)
    expect(prepare).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not let an Organization-wide read stand in for the member Role grant', async () => {
    const { app, batches, cookie, decode } = await fixture(true)
    const response = await app.request(path, { headers: { cookie } })
    expect(response.status).toBe(503)
    expect(batches).toHaveLength(0)
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not consult the parameter fallback when an exact endpoint wins dispatch', async () => {
    const { app, batches, cookie } = await fixture()
    const response = await app.request('/overlap/chosen', {
      headers: { cookie, 'X-Org-Id': 'alpha' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ label: marker })
    expect(batches).toHaveLength(1)
    expect(batches[0]).not.toContainEqual({ success: true, results: [{ access: 'read' }] })
  })

  it('refuses ambiguous parameter endpoint matches before loading facts', async () => {
    const { app, batches, cookie } = await fixture()
    expect((await app.request('/conflict/start/tail', { headers: { cookie } })).status).toBe(503)
    expect(batches).toHaveLength(0)
  })

  it('binds an ALL endpoint to its path Organization', async () => {
    const { app, batches, cookie } = await fixture()
    const allowed = await app.request('/all/alpha', { method: 'PATCH', headers: { cookie } })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ label: marker })
    expect(batches).toHaveLength(1)
    const conflicted = await app.request('/all/alpha', {
      method: 'PATCH',
      headers: { cookie, 'X-Org-Id': 'other' },
    })
    expect(conflicted.status).toBe(403)
  })

  it('does not dispatch or decode when an admitted fact has a failed Product sibling', async () => {
    const { app, batches, cookie, decode, failure, productHandler } = await fixture()
    failure.productSibling = true
    const response = await app.request('/all/alpha', { headers: { cookie } })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: 'Authorization unavailable' })
    expect(batches[0]).toContainEqual({ success: false, results: [] })
    expect(batches[0]).toContainEqual({ success: true, results: [{ label: marker }] })
    expect(decode).not.toHaveBeenCalled()
    expect(productHandler).not.toHaveBeenCalled()
  })

  it.each(['availability', 'grant'] as const)(
    'treats unreadable Module %s as unavailable',
    async (kind) => {
      const { app, cookie, decode, failure } = await fixture()
      failure.malformedPolicy = kind
      const response = await app.request(path, { headers: { cookie } })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ message: 'Authorization unavailable' })
      expect(decode).not.toHaveBeenCalled()
    },
  )

  it('does not disclose an overflowing Product fact to a nonmember', async () => {
    const { app, batches, cookie, decode, sqlite } = await fixture()
    const headers = { cookie }
    const allowed = await app.request(path, { headers })
    expect(await allowed.json()).toEqual({ label: marker })
    sqlite.prepare('INSERT INTO product_cards VALUES (?, ?)').run('alpha', 'second label')
    expect((await app.request(path, { headers })).status).toBe(503)
    decode.mockClear()
    sqlite.exec('DELETE FROM member')
    const refused = await app.request(path, { headers })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ message: 'Organization not found' })
    expect(batches.at(-1)).toContainEqual({
      success: true,
      results: [{ label: marker }, { label: 'second label' }],
    })
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects invalid or private fact declarations', () => {
    const decode = vi.fn()
    expect(() => defineAuthorizationFact({ ...projection, maxRows: 0, decode })).toThrow(TypeError)
    expect(() =>
      defineAuthorizationFact({
        ...projection,
        table: { ...projection.table, name: 'session' },
        decode,
      }),
    ).toThrow(TypeError)
    expect(decode).not.toHaveBeenCalled()
  })

  it('enforces organization and platform roles and limits break-glass actions', async () => {
    const { app, cookie, sqlite, userId } = await fixture()
    const headers = { cookie }
    expect((await app.request('/orgs/alpha/admin', { headers })).status).toBe(403)
    sqlite.exec("UPDATE member SET role = 'admin'")
    expect((await app.request('/orgs/alpha/admin', { headers })).status).toBe(200)
    expect((await app.request('/staff', { headers })).status).toBe(403)
    sqlite
      .prepare('INSERT INTO user_platform_roles (user_id, role, updated_at) VALUES (?, ?, ?)')
      .run(userId, 'staff', 1)
    expect((await app.request('/staff', { headers })).status).toBe(200)

    sqlite.exec("DELETE FROM member; UPDATE user_platform_roles SET role = 'super_admin';")
    expect((await app.request('/orgs/alpha/write', { method: 'POST', headers })).status).toBe(403)
    expect((await app.request('/orgs/alpha', { method: 'DELETE', headers })).status).toBe(403)
  })
})
