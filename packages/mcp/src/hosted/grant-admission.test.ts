import { OAuthError } from '@cloudflare/workers-oauth-provider'
import { describe, expect, it, vi } from 'vitest'
import { type Admission, fixture, USER } from './oauth-fixture.test-support'

function denyFixture() {
  const denials = new Set<string>()
  const key = (userId: string, grantId: string, clientId: string) =>
    JSON.stringify([userId, grantId, clientId])
  const f = fixture(
    async ({ userId, grantId, clientId }) => !denials.has(key(userId, grantId, clientId)),
  )
  return {
    ...f,
    deny: (grantId: string, clientId: string) => denials.add(key(USER, grantId, clientId)),
  }
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toContain('no-store')
}

describe('hosted OAuth grant admission', () => {
  it.each(['disabled', 'missing', 'unavailable'] as const)(
    'checks live account state without optional admission: %s',
    async (state) => {
      const f = fixture()
      const grant = await f.issue()
      expect((await f.call(grant.access_token)).status).toBe(200)
      const before = f.auth.budget.count
      f.setAccountState(state)
      expect((await f.call(grant.access_token)).status).toBe(state === 'unavailable' ? 503 : 401)
      expect(f.auth.budget.count - before).toBe(1)
      expect(f.counts()).toEqual({ registered: 1, executed: 1 })
      expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
      const response = await f.refresh(grant.clientId, grant.refresh_token)
      expect(response.status).toBe(state === 'unavailable' ? 503 : 400)
      expect(await response.json()).not.toHaveProperty('access_token')
      expect(await f.helpers.unwrapToken(grant.access_token)).toEqual(
        state === 'unavailable' ? expect.objectContaining({ userId: USER }) : null,
      )
    },
  )

  it('denies refresh after the account is disabled without optional admission', async () => {
    const f = fixture()
    const grant = await f.issue()
    f.setAccountState('disabled')
    const response = await f.refresh(grant.clientId, grant.refresh_token)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('denies code exchange after the account is disabled without optional admission', async () => {
    const f = fixture()
    const code = await f.code()
    f.setAccountState('disabled')
    const response = await f.exchange(code)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('preserves existing issuance and tool access when omitted', async () => {
    const f = fixture()
    const grant = await f.issue()
    const before = f.auth.budget.count
    const response = await f.call(grant.access_token)
    expect(response.status).toBe(200)
    expect(f.auth.budget.count - before).toBe(1)
    expect(await response.text()).toContain(USER)
    expect(f.counts()).toEqual({ registered: 1, executed: 1 })
    expect((await f.refresh(grant.clientId, grant.refresh_token)).status).toBe(200)
    expect(f.auth.budget.count - before).toBe(2)
  })

  it('rejects a falsy non-function admission option at construction', () => {
    expect(() => fixture(false as unknown as Admission)).toThrow(TypeError)
  })

  it('snapshots the admission callback when the worker is created', async () => {
    const f = fixture(async (input) => input.phase !== 'request')
    f.options.grantAdmission = async () => true
    const grant = await f.issue()
    expect((await f.call(grant.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
  })

  it('cannot bypass provider PKCE or bearer validation when admission allows', async () => {
    const f = fixture(async () => true)
    const c = await f.code()
    const bad = await f.exchange(c, 'wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' })
    const denied = await f.call('not-a-valid-token')
    expect(denied.status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
  })

  it('refuses a request before registering or executing tools', async () => {
    const f = fixture(async (input) => input.phase !== 'request')
    const grant = await f.issue()
    const response = await f.call(grant.access_token)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata')
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    expect((await f.helpers.listUserGrants(USER)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: grant.summary.grantId })]),
    )
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
  })

  it('does not run grant policy or register tools on an unreadable account batch', async () => {
    const admission = vi.fn<Admission>(async () => true)
    const f = fixture(admission)
    const grant = await f.issue()
    admission.mockClear()
    f.auth.setUnreadable(true)
    const response = await f.call(grant.access_token, { 'X-Org-Id': 'ignored' })
    await expectUnavailable(response)
    expect(await response.text()).toBe('Service unavailable')
    expect(admission).not.toHaveBeenCalled()
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
  })

  it('refuses an authorization code without issuing tokens', async () => {
    const f = fixture(async (input) => input.phase !== 'token')
    const c = await f.code()
    const before = (await f.helpers.listUserGrants(USER)).items
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ clientId: c.clientId })
    const response = await f.exchange(c)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ error: 'invalid_grant' })
    expect(body).not.toHaveProperty('access_token')
    expect(body).not.toHaveProperty('refresh_token')
    expect((await f.helpers.listUserGrants(USER)).items).toEqual([])
  })

  it('refuses refresh and revokes only the targeted grant', async () => {
    let blocked = ''
    const f = fixture(
      async (input) =>
        input.phase !== 'token' || input.grantType !== 'refresh_token' || input.grantId !== blocked,
    )
    const first = await f.issue()
    const second = await f.issue()
    blocked = first.summary.grantId
    const denied = await f.refresh(first.clientId, first.refresh_token)
    expect(denied.status).toBe(400)
    const body = await denied.json()
    expect(body).toMatchObject({ error: 'invalid_grant' })
    expect(body).not.toHaveProperty('access_token')
    expect(await f.helpers.unwrapToken(first.access_token)).toBeNull()
    expect((await f.call(second.access_token)).status).toBe(200)
    expect((await f.refresh(second.clientId, second.refresh_token)).status).toBe(200)
  })

  it('isolates a request refusal to the selected grant', async () => {
    let blocked = ''
    const f = fixture(async (input) => input.phase !== 'request' || input.grantId !== blocked)
    const first = await f.issue()
    const second = await f.issue()
    blocked = first.summary.grantId
    expect((await f.call(first.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    expect((await f.call(second.access_token)).status).toBe(200)
    expect(f.counts()).toEqual({ registered: 1, executed: 1 })
  })

  it.each([
    ['ordinary error', () => new Error('offline')],
    [
      'caller OAuth invalid_grant',
      () => new OAuthError('invalid_grant', { description: 'offline' }),
    ],
  ])(
    'returns unavailable for %s during code admission and permits retry',
    async (_label, error) => {
      let unavailable = true
      const f = fixture(async (input) => {
        if (input.phase === 'token' && unavailable) throw error()
        return true
      })
      const c = await f.code()
      const response = await f.exchange(c)
      await expectUnavailable(response)
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' })
      unavailable = false
      expect((await f.exchange(c)).status).toBe(200)
    },
  )

  it('returns unavailable on refresh without revocation and permits retry', async () => {
    let unavailable = false
    const f = fixture(async (input) => {
      if (input.phase === 'token' && unavailable) throw new Error('offline')
      return true
    })
    const grant = await f.issue()
    unavailable = true
    const response = await f.refresh(grant.clientId, grant.refresh_token)
    await expectUnavailable(response)
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' })
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    unavailable = false
    expect((await f.refresh(grant.clientId, grant.refresh_token)).status).toBe(200)
  })

  it('fails closed on request admission errors and recovers without revocation', async () => {
    let unavailable = true
    const f = fixture(async (input) => {
      if (input.phase === 'request' && unavailable) throw new Error('offline')
      return true
    })
    const grant = await f.issue()
    await expectUnavailable(await f.call(grant.access_token))
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
    unavailable = false
    expect((await f.call(grant.access_token)).status).toBe(200)
  })

  it.each([undefined, 'allow'])(
    'treats a nonboolean admission result %s as unavailable, without consuming the code',
    async (invalid) => {
      let valid = false
      const f = fixture(async () => (valid ? true : (invalid as unknown as boolean)))
      const c = await f.code()
      await expectUnavailable(await f.exchange(c))
      valid = true
      expect((await f.exchange(c)).status).toBe(200)
    },
  )

  it('binds admission to the provider-verified tuple rather than caller headers', async () => {
    let target = ''
    let client = ''
    const f = fixture(async (input, env) => {
      if ('OAUTH_PROVIDER' in env) return false
      if (input.phase === 'token')
        return (
          input.userId === USER &&
          input.clientId === client &&
          input.grantType === 'authorization_code'
        )
      return input.userId === USER && input.grantId === target && input.clientId === client
    })
    const c = await f.code()
    client = c.clientId
    const response = await f.exchange(c)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { access_token: string }
    const summary = await f.helpers.unwrapToken(body.access_token)
    expect(summary).not.toBeNull()
    target = summary!.grantId
    const allowed = await f.call(body.access_token, {
      'x-user-id': 'forged',
      'x-client-id': 'forged',
      'x-grant-id': 'forged',
    })
    expect(allowed.status).toBe(200)
    target = 'wrong-grant'
    expect((await f.call(body.access_token)).status).toBe(401)
    expect(f.counts()).toEqual({ registered: 1, executed: 1 })
  })

  it('rejects a provider grant whose token identity disagrees with the verified user', async () => {
    const f = fixture(async () => true)
    const c = await f.code(true)
    const exchange = await f.exchange(c)
    expect(exchange.status).toBe(200)
    const body = (await exchange.json()) as { access_token: string }
    const before = f.auth.budget.count
    expect((await f.call(body.access_token)).status).toBe(401)
    expect(f.auth.budget.count - before).toBe(0)
    expect(f.counts()).toEqual({ registered: 0, executed: 0 })
  })
})

describe('hosted grant policy barriers', () => {
  it('denies only the matching OAuth grant without revoking on a resource refusal', async () => {
    const f = denyFixture()
    const first = await f.issue()
    const second = await f.issue()
    f.deny(first.summary.grantId, second.clientId)
    expect((await f.call(first.access_token)).status).toBe(200)
    f.deny(first.summary.grantId, first.clientId)

    const before = f.auth.budget.count
    expect((await f.call(first.access_token)).status).toBe(401)
    expect(f.auth.budget.count - before).toBe(1)
    expect(await f.helpers.unwrapToken(first.access_token)).not.toBeNull()

    const refused = await f.refresh(first.clientId, first.refresh_token)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual(expect.objectContaining({ error: 'invalid_grant' }))
    expect(f.auth.budget.count - before).toBe(2)
    expect(await f.helpers.unwrapToken(first.access_token)).toBeNull()
    expect((await f.call(second.access_token)).status).toBe(200)
  })

  it('checks grant policy on code exchange and revokes just that grant', async () => {
    const f = denyFixture()
    const other = await f.issue()
    const code = await f.code()
    const target = (await f.helpers.listUserGrants(USER)).items.find(
      ({ clientId }) => clientId === code.clientId,
    )
    expect(target).toBeDefined()
    f.deny(target!.id, code.clientId)
    const before = f.auth.budget.count
    const response = await f.exchange(code)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
    expect(f.auth.budget.count - before).toBe(1)
    expect((await f.helpers.listUserGrants(USER)).items.map(({ id }) => id)).toEqual([
      other.summary.grantId,
    ])
  })

  it('keeps codes and refresh tokens retryable on unavailable D1 admission', async () => {
    const f = denyFixture()
    const grant = await f.issue()
    const code = await f.code()
    f.setAccountState('unavailable')
    for (const exchange of [
      () => f.exchange(code),
      () => f.refresh(grant.clientId, grant.refresh_token),
    ]) {
      const before = f.auth.budget.count
      const response = await exchange()
      await expectUnavailable(response)
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' })
      expect(f.auth.budget.count - before).toBe(1)
    }
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    f.setAccountState('active')
    expect((await f.exchange(code)).status).toBe(200)
    expect((await f.refresh(grant.clientId, grant.refresh_token)).status).toBe(200)
  })
})
