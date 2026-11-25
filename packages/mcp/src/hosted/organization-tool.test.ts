import type { HostedDispatch } from '@kit/auth/hosted-dispatch'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { PUBLIC_TOOL_ERROR_MESSAGES } from '../index'
import type { createHostedMcpWorker } from './create-worker'
import type { HostedMcpEnv } from './env'
import { type Admission, fixture, USER } from './oauth-fixture.test-support'
import {
  CAUSE,
  call,
  ORG,
  OTHER,
  organizationFixture,
  PRIVATE,
  type Reply,
  UNKNOWN,
} from './organization-tool.test-support'

function expectRefusal(reply: Reply) {
  const payload = { code: 'ORGANIZATION_ACCESS_REFUSED' }
  expect(reply.result).toEqual({
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  })
}

function expectAllowed(reply: Reply, id: string, role = 'member') {
  expect(reply.result.isError).toBeUndefined()
  expect(JSON.parse(reply.result.content[0]!.text)).toEqual({ id, role, data: PRIVATE })
}

describe('hosted Organization tools', () => {
  it('validates twice without supplying an omitted selector, then designates from input or a server default', async () => {
    const f = organizationFixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    const before = f.auth.budget.count
    const response = await f.fetchMcp(token, call(1))
    expectAllowed((await response.json()) as Reply, ORG)
    expect(f.observedInput.mock.calls).toEqual([[false], [false]])
    expect(f.designate).toHaveBeenCalledExactlyOnceWith({})
    expect(f.auth.budget.count - before).toBe(2)

    const explicit = await f.fetchMcp(token, call(2, 'scoped', { organizationId: OTHER }), {
      'X-Org-Id': OTHER,
    })
    expectAllowed((await explicit.json()) as Reply, OTHER)
    expect(f.observedInput.mock.calls).toEqual([[false], [false], [true], [true]])
    expect(f.auth.budget.count - before).toBe(4)
  })

  it.each([
    [{}, ORG],
    [{ organizationId: '   ' }, undefined],
    [{ organizationId: ` ${ORG} ` }, undefined],
    [{ organizationId: ORG }, OTHER],
    [{ organizationId: ORG }, `\u00a0${ORG}`],
    [{ organizationId: `${ORG}, ${OTHER}` }, `${ORG}, ${OTHER}`],
    [{ organizationId: ORG }, `${ORG}, ${ORG}`],
  ] as const)(
    'refuses malformed, absent or conflicting designation %j / %s without a scoped read',
    async (args, header) => {
      const f = organizationFixture()
      const { access_token: token } = await f.issue()
      const before = f.auth.budget.count
      const headers = new Headers()
      for (const value of header?.split(', ') ?? []) headers.append('X-Org-Id', value)
      const response = await f.fetchMcp(token, call(1, 'scoped', args), headers)
      expect(response.status).toBe(200)
      expectRefusal((await response.json()) as Reply)
      expect(f.entered).not.toHaveBeenCalled()
      expect(f.auth.budget.count - before).toBe(1)
      expect(await f.helpers.unwrapToken(token)).not.toBeNull()
    },
  )

  it('refuses a thenable designation without looking up or invoking then', async () => {
    const f = organizationFixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    const then = vi.fn(() => {
      throw new Error(CAUSE)
    })
    const get = vi.fn((target: object, key: PropertyKey, receiver: unknown) =>
      Reflect.get(target, key, receiver),
    )
    f.designate.mockReturnValueOnce(new Proxy({ then }, { get }) as never)
    const before = f.auth.budget.count
    expectRefusal((await (await f.fetchMcp(token, call(1))).json()) as Reply)
    expect(get).not.toHaveBeenCalled()
    expect(then).not.toHaveBeenCalled()
    expect(f.auth.budget.count - before).toBe(1)
  })

  it('discovers via an Org-free dispatch, then checks the designated Organization without credentials or extra reads', async () => {
    const grantAdmission = vi.fn<Admission>(async () => true)
    const f = organizationFixture({ admission: grantAdmission })
    const { access_token: token } = await f.issue()
    grantAdmission.mockClear()
    const before = f.auth.budget.count
    const response = await f.fetchMcp(token, call(1, 'discovered'), {
      'X-Org-Id': ORG,
      cookie: 'private=cookie',
    })
    expectAllowed((await response.json()) as Reply, ORG)
    expect(f.discovery).toHaveBeenCalledExactlyOnceWith(undefined, undefined, undefined, undefined)
    expect(f.auth.budget.count - before).toBe(3)
    expect(grantAdmission).toHaveBeenCalledTimes(1)

    const conflict = await f.fetchMcp(token, call(2, 'discovered'), {
      'X-Org-Id': `${ORG}, ${ORG}`,
    })
    expectRefusal((await conflict.json()) as Reply)
    expect(f.discovery).toHaveBeenCalledTimes(2)
    expect(f.entered).toHaveBeenCalledExactlyOnceWith(ORG)
    expect(f.auth.budget.count - before).toBe(5)
  })

  it('rechecks Organization status and membership, without fallback for staff or revoking on refusal', async () => {
    const f = organizationFixture({ defaultOrg: OTHER })
    const { access_token: token } = await f.issue()
    f.auth.sqlite
      .prepare(
        "INSERT INTO user_platform_roles (user_id, role, updated_at) VALUES (?, 'super_admin', 0)",
      )
      .run(USER)
    const invoke = async (organizationId: string) => {
      const before = f.auth.budget.count
      const response = await f.fetchMcp(token, call(1, 'scoped', { organizationId }))
      expect(f.auth.budget.count - before).toBe(2)
      return (await response.json()) as Reply
    }
    expectAllowed(await invoke(ORG), ORG)
    f.auth.sqlite.prepare("UPDATE organization SET status = 'suspended' WHERE id = ?").run(ORG)
    expectRefusal(await invoke(ORG))
    expectRefusal(await invoke(UNKNOWN))
    f.auth.sqlite.prepare("UPDATE organization SET status = 'active' WHERE id = ?").run(ORG)
    f.auth.sqlite.prepare("UPDATE member SET role = 'admin' WHERE organization_id = ?").run(ORG)
    expectAllowed(await invoke(ORG), ORG, 'admin')
    f.auth.sqlite.prepare('DELETE FROM member WHERE organization_id = ?').run(ORG)
    expectRefusal(await invoke(ORG))
    expect(f.entered.mock.calls).toEqual([[ORG], [ORG]])
    expect(await f.helpers.unwrapToken(token)).not.toBeNull()
  })

  it.each(['membership', 'disabled user', 'grant policy'] as const)(
    'applies mid-request %s changes at the correct admission boundary',
    async (change) => {
      let allowed = true
      const admission = vi.fn<Admission>(async () => allowed)
      const f = organizationFixture({ defaultOrg: ORG, admission })
      const { access_token: token } = await f.issue()
      f.entered.mockImplementationOnce(() => {
        if (change === 'membership') {
          f.auth.sqlite.prepare('DELETE FROM member WHERE organization_id = ?').run(ORG)
        } else if (change === 'disabled user') {
          f.setAccountState('disabled')
        } else {
          allowed = false
        }
      })
      const before = f.auth.budget.count
      admission.mockClear()
      const response = await f.fetchMcp(token, [call(1), call(2)])
      const [first, second] = (await response.json()) as [Reply, Reply]
      expectAllowed(first, ORG)
      if (change === 'grant policy') expectAllowed(second, ORG)
      else expectRefusal(second)
      expect(f.auth.budget.count - before).toBe(3)
      expect(admission).toHaveBeenCalledTimes(1)

      const next = await f.fetchMcp(token, call(3))
      if (change === 'membership') expectRefusal((await next.json()) as Reply)
      else expect(next.status).toBe(401)
      expect(await f.helpers.unwrapToken(token)).not.toBeNull()
    },
  )

  it('maps a failed scoped batch to sanitized UNAVAILABLE and permits retry without revocation', async () => {
    const f = organizationFixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    const before = f.auth.budget.count
    f.auth.setBeforeBatch(() => {
      if (f.auth.budget.count === before + 2) throw new Error(CAUSE)
    })
    const response = await f.fetchMcp(token, call(1))
    const result = ((await response.json()) as Reply).result
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0]?.text).toContain(PUBLIC_TOOL_ERROR_MESSAGES.UNAVAILABLE)
    expect(JSON.stringify(result)).not.toContain(CAUSE)
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
    expect(f.entered).not.toHaveBeenCalled()
    expect(f.auth.budget.count - before).toBe(2)
    expect(await f.helpers.unwrapToken(token)).not.toBeNull()
    expectAllowed((await (await f.fetchMcp(token, call(2))).json()) as Reply, ORG)
  })

  it('takes eight slots synchronously across concurrent calls and shares them across tools', async () => {
    const f = organizationFixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    const before = f.auth.budget.count
    f.auth.setBeforeBatch(() => {
      if (f.auth.budget.count === before + 4) throw new Error(CAUSE)
    })
    const response = await f.fetchMcp(token, [call(1, 'burst'), call(2), call(3, 'who')])
    const [burst, overflow, unscoped] = (await response.json()) as [Reply, Reply, Reply]
    expect(JSON.parse(burst.result.content[0]!.text)).toEqual([
      400, 404, 200, 503, 200, 200, 200, 200, 200, 429,
    ])
    expectRefusal(overflow)
    expect(unscoped.result.content[0]?.text).toBe(USER)
    expect(f.auth.budget.count - before).toBe(9)
    expect(f.entered).toHaveBeenCalledTimes(5)
    expectAllowed((await (await f.fetchMcp(token, call(4))).json()) as Reply, ORG)
    const dispatch = f.captured()!
    const after = f.auth.budget.count
    expect(
      (await dispatch.fetch({ method: 'GET', path: '/scope', organizationId: ORG })).status,
    ).toBe(401)
    expect(f.auth.budget.count).toBe(after)
    expect(await f.helpers.unwrapToken(token)).not.toBeNull()
  })

  it('uses the default register signature and omits dispatch when no App is configured', async () => {
    type Register = Parameters<typeof createHostedMcpWorker>[0]['register']
    type RegisterForEnv = Parameters<typeof createHostedMcpWorker<HostedMcpEnv>>[0]['register']
    type Dispatch = Pick<HostedDispatch, 'fetch'> | undefined
    expectTypeOf<Parameters<Register>[1]['dispatch']>().toEqualTypeOf<Dispatch>()
    expectTypeOf<Parameters<RegisterForEnv>[1]['dispatch']>().toEqualTypeOf<Dispatch>()
    const f = fixture()
    f.options.register = vi.fn()
    const { access_token: token } = await f.issue()
    const response = await f.call(token)
    expect(response.status).toBe(200)
    expect(f.options.register).not.toHaveBeenCalled()
    expect(f.registrations).toHaveLength(1)
    expect(f.registrations[0]).toMatchObject({ identity: { userId: USER } })
    expect(f.registrations[0]).not.toHaveProperty('dispatch')
    expect(f.registrations[0]!.env).not.toHaveProperty('OAUTH_PROVIDER')
  })
})
