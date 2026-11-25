import { OAuthError } from '@cloudflare/workers-oauth-provider'
import {
  type AuthorizationFact,
  type AuthorizationRow,
  defineAuthorizationFact,
} from '@kit/auth/snapshot'
import { countD1RoundTrips } from '@kit/db/testing'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAuthFixture } from './auth-fixture.test-support'
import { createHostedMcpWorker, type HostedMcpWorkerOptions } from './create-worker'
import type { HostedMcpEnv } from './env'
import { createOAuthFixture, ORIGIN, USER } from './oauth-fixture.test-support'

type Admission = NonNullable<HostedMcpWorkerOptions<HostedMcpEnv>['grantAdmission']>

type AccountState = 'active' | 'disabled' | 'missing' | 'unavailable'

function admissionDb() {
  const { db, sqlite } = createAuthFixture(USER)
  let unavailable = false
  let unreadable = false
  let results: unknown
  const budget = countD1RoundTrips({
    ...db,
    async batch(statements: unknown[]) {
      if (unavailable) throw new Error('D1 unavailable')
      results = await db.batch(statements)
      if (unreadable && Array.isArray(results)) {
        return [{ success: false }, ...results.slice(1)]
      }
      return results
    },
  })
  return {
    sqlite,
    budget,
    get results() {
      return results
    },
    setUnreadable(state: boolean) {
      unreadable = state
    },
    setAccountState(state: AccountState) {
      unavailable = state === 'unavailable'
      if (state === 'missing') {
        sqlite.prepare('DELETE FROM user WHERE id = ?').run(USER)
      } else if (!unavailable) {
        sqlite
          .prepare('UPDATE user SET disabled = ? WHERE id = ?')
          .run(Number(state === 'disabled'), USER)
      }
    },
  }
}

function fixture(
  admission?: Admission,
  snapshot: {
    organizationFact?: AuthorizationFact<string>
    denyFact?: AuthorizationFact<unknown>
  } = {},
) {
  const auth = admissionDb()
  let registered = 0
  let executed = 0
  const options: HostedMcpWorkerOptions<HostedMcpEnv> = {
    name: 'admission-test',
    identityPort: { resolve: async () => ({ userId: USER, email: 'demo@kit.local' }) },
    apiBaseUrl: () => 'http://127.0.0.1:8787',
    consent: { mode: 'demo-loopback', email: 'demo@kit.local' },
    register(server, { authorization }) {
      registered++
      server.addTool({
        name: 'who',
        description: 'test tool',
        execute: async () => {
          executed++
          return USER
        },
      })
      const { organizationFact } = snapshot
      if (organizationFact) {
        server.addTool({
          name: 'scoped',
          description: 'test organization-scoped tool',
          parameters: z.object({ organizationId: z.string().trim().min(1) }),
          execute: async ({ organizationId }) => {
            const scope = authorization.forOrganization(organizationId)
            if (scope?.organization.membershipRole !== 'member') {
              return { isError: true, content: [{ type: 'text', text: 'Scope refused' }] }
            }
            return scope.fact(organizationFact)
          },
        })
      }
    },
    ...(admission !== undefined ? { grantAdmission: admission } : {}),
    ...(snapshot.organizationFact ? { facts: [snapshot.organizationFact] } : {}),
    ...(snapshot.denyFact ? { denyFact: snapshot.denyFact } : {}),
  }
  const oauth = createOAuthFixture(
    createHostedMcpWorker(options),
    auth.budget.db as unknown as D1Database,
    auth.budget,
  )

  function call(
    accessToken: string,
    extraHeaders: Record<string, string> = {},
    organizationId?: string,
  ) {
    return oauth.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params:
            organizationId === undefined
              ? { name: 'who', arguments: {} }
              : { name: 'scoped', arguments: { organizationId } },
        }),
      }),
    )
  }
  return {
    ...oauth,
    call,
    auth,
    setAccountState: auth.setAccountState,
    options,
    counts: () => ({ registered, executed }),
  }
}

const ORG = 'org_selected'
const OTHER_ORG = 'org_other'
const PRIVATE_LABEL = 'selected-organization-private-label'
const OTHER_LABEL = 'other-organization-private-label'

function scopedFixture(admission?: Admission) {
  const decode = vi.fn((rows: readonly AuthorizationRow[]) => z.string().parse(rows[0]?.label))
  const organizationFact = defineAuthorizationFact({
    table: { name: 'product_contacts', columns: ['organization_id', 'label'] },
    scope: { kind: 'organization', organizationId: 'organization_id' },
    select: ['label'],
    decode,
  })
  const f = fixture(admission, { organizationFact })
  f.auth.sqlite.exec(
    'CREATE TABLE product_contacts (organization_id TEXT NOT NULL, label TEXT NOT NULL)',
  )
  for (const [orgId, label] of [
    [ORG, PRIVATE_LABEL],
    [OTHER_ORG, OTHER_LABEL],
  ] as const) {
    f.auth.sqlite
      .prepare('INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)')
      .run(orgId, orgId, orgId)
    f.auth.sqlite
      .prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', 0)",
      )
      .run(`${orgId}_member`, orgId, USER)
    f.auth.sqlite.prepare('INSERT INTO product_contacts VALUES (?, ?)').run(orgId, label)
  }
  return { ...f, decode }
}

function denyFixture() {
  const decode = vi.fn(() => 'do-not-decode-a-deny-fact')
  const denyFact = defineAuthorizationFact({
    table: { name: 'product_grant_denials', columns: ['user_id', 'grant_id', 'client_id'] },
    scope: { kind: 'hosted-grant', userId: 'user_id', grantId: 'grant_id', clientId: 'client_id' },
    select: ['grant_id'],
    decode,
  })
  const f = fixture(undefined, { denyFact })
  f.auth.sqlite.exec(
    'CREATE TABLE product_grant_denials (user_id TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL)',
  )
  const deny = f.auth.sqlite.prepare('INSERT INTO product_grant_denials VALUES (?, ?, ?)')
  return {
    ...f,
    decode,
    deny: (grantId: string, clientId: string) => deny.run(USER, grantId, clientId),
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

describe('hosted request authorization snapshot', () => {
  it('binds a scoped tool to the selected organization and rechecks its membership and status', async () => {
    const f = scopedFixture()
    const grant = await f.issue()
    async function scopedCall(organizationId: string, selected?: string) {
      const before = f.auth.budget.count
      const result = await f.call(
        grant.access_token,
        selected ? { 'X-Org-Id': selected } : {},
        organizationId,
      )
      expect(result.status).toBe(200)
      expect(f.auth.budget.count - before).toBe(1)
      return result.json()
    }

    const matched = await scopedCall(ORG, ORG)
    expect(JSON.stringify(matched)).toContain(PRIVATE_LABEL)
    expect(JSON.stringify(matched)).not.toContain(OTHER_LABEL)
    expect(f.decode).toHaveBeenCalledExactlyOnceWith([{ label: PRIVATE_LABEL }])
    f.decode.mockClear()

    for (const [operation, selector] of [
      [ORG, undefined],
      [OTHER_ORG, ORG],
    ] as const) {
      const refused = await scopedCall(operation, selector)
      expect(refused).toMatchObject({ result: { isError: true } })
      expect(JSON.stringify(refused)).not.toContain(PRIVATE_LABEL)
      expect(JSON.stringify(refused)).not.toContain(OTHER_LABEL)
      const boundRows = JSON.stringify(f.auth.results)
      expect(boundRows).not.toContain(OTHER_LABEL)
      if (selector) expect(boundRows).toContain(PRIVATE_LABEL)
      else expect(boundRows).not.toContain(PRIVATE_LABEL)
    }
    expect(f.decode).not.toHaveBeenCalled()

    f.auth.sqlite.prepare("UPDATE organization SET status = 'suspended' WHERE id = ?").run(ORG)
    expect(await scopedCall(ORG, ORG)).toMatchObject({ result: { isError: true } })
    f.auth.sqlite.prepare("UPDATE organization SET status = 'active' WHERE id = ?").run(ORG)
    f.auth.sqlite
      .prepare('DELETE FROM member WHERE organization_id = ? AND user_id = ?')
      .run(ORG, USER)
    expect(await scopedCall(ORG, ORG)).toMatchObject({ result: { isError: true } })
    expect(f.decode).not.toHaveBeenCalled()
    expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    const withoutSelector = await f.call(grant.access_token)
    expect(withoutSelector.status).toBe(200)
    expect(await withoutSelector.text()).toContain(USER)
  })

  it('keeps returned facts private on an external denial or a partial batch failure', async () => {
    let requestAllowed = true
    const admit = vi.fn<Admission>(async (input) => input.phase === 'token' || requestAllowed)
    const f = scopedFixture(admit)
    const grant = await f.issue()
    const headers = { 'X-Org-Id': ORG }
    const logs = (['debug', 'error', 'info', 'log', 'warn'] as const).map((level) =>
      vi.spyOn(console, level),
    )
    try {
      requestAllowed = false
      const denied = await f.call(grant.access_token, headers, ORG)
      expect(denied.status).toBe(401)
      expect(await denied.text()).not.toContain(PRIVATE_LABEL)
      expect(JSON.stringify(f.auth.results)).toContain(PRIVATE_LABEL)
      expect(admit.mock.lastCall?.[0]).toEqual({
        phase: 'request',
        userId: USER,
        grantId: grant.summary.grantId,
        clientId: grant.clientId,
      })
      expect(admit.mock.lastCall?.[1]).not.toHaveProperty('OAUTH_PROVIDER')
      expect(admit.mock.lastCall).toHaveLength(2)

      requestAllowed = true
      admit.mockClear()
      f.auth.setUnreadable(true)
      const unavailable = await f.call(grant.access_token, headers, ORG)
      await expectUnavailable(unavailable)
      expect(await unavailable.text()).toBe('Service unavailable')
      expect(JSON.stringify(f.auth.results)).toContain(PRIVATE_LABEL)
      expect(admit).not.toHaveBeenCalled()
      expect(f.counts()).toEqual({ registered: 0, executed: 0 })
      expect(f.decode).not.toHaveBeenCalled()
      expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(PRIVATE_LABEL)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
    f.auth.setUnreadable(false)
    const admitted = await f.call(grant.access_token, headers, ORG)
    expect(admitted.status).toBe(200)
    expect(await admitted.text()).toContain(PRIVATE_LABEL)
    expect(f.decode).toHaveBeenCalledExactlyOnceWith([{ label: PRIVATE_LABEL }])
  })

  it('denies only the matching OAuth grant, without decoding the deny fact or revoking on a resource refusal', async () => {
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
    expect(f.decode).not.toHaveBeenCalled()
  })

  it('checks the D1-backed denial on code exchange and revokes just that grant', async () => {
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
    expect(f.decode).not.toHaveBeenCalled()
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
