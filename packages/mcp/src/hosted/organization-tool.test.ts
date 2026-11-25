import { setImmediate } from 'node:timers/promises'
import type { HostedAuthorization } from '@kit/auth/snapshot'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { PUBLIC_TOOL_ERROR_MESSAGES } from '../index'
import type { HostedMcpEnv } from './env'
import { createHostedMcpWorker, type OrganizationToolAuthorization } from './index'
import { USER } from './oauth-fixture.test-support'
import { CAUSE, type Statement } from './organization-db.test-support'
import {
  call,
  fixture,
  ORG,
  OTHER,
  POLICY,
  PRIVATE,
  type Reply,
  sampleOrgFact,
  type ToolOptions,
  workerOptions,
} from './organization-tool.test-support'

function expectRefusal(reply: Reply, code: string) {
  expect(reply.result.isError).toBe(true)
  expect(reply.result.structuredContent).toEqual({ code })
  expect(reply.result.content).toEqual([{ type: 'text', text: JSON.stringify({ code }) }])
}

function expectUnavailable(reply: Reply) {
  expect(reply.result.isError).toBe(true)
  expect(reply.result.structuredContent).toBeUndefined()
  expect(reply.result.content[0]?.text).toContain(PUBLIC_TOOL_ERROR_MESSAGES.UNAVAILABLE)
}

function expectAllowed(reply: Reply, org: string) {
  expect(reply.result.isError).toBeUndefined()
  expect(JSON.parse(reply.result.content[0]?.text ?? '')).toEqual({
    organizationId: org,
    data: `${PRIVATE}:${org}`,
  })
}

describe('hosted tool-input Organization selection', () => {
  it.each([undefined, 'matching header'] as const)(
    'designates explicit input and genuine omission (%s)',
    async (header) => {
      const f = fixture({ defaultOrg: ORG })
      const { access_token: token } = await f.issue()
      expectAllowed(await f.dispatch(token, { organizationId: OTHER }, 2, header && OTHER), OTHER)
      expectAllowed(await f.dispatch(token, {}, 2, header && ORG), ORG)
      expect(f.observedPolicy.mock.calls).toEqual([
        [{ id: OTHER, role: 'member' }],
        [{ id: ORG, role: 'member' }],
      ])
      expect(f.observedExecute.mock.calls).toEqual([[OTHER], [ORG]])
    },
  )

  it.each([
    [{}, undefined],
    [{}, ORG],
    [{ organizationId: '   ' }, undefined],
    [{ organizationId: ` ${ORG} ` }, undefined],
    [{ organizationId: ORG }, OTHER],
    [{ organizationId: ORG }, `\u00a0${ORG}`],
  ] as const)(
    'rejects an absent, noncanonical, conflicting or ambiguous designation: %j, %s',
    async (args, header) => {
      const f = fixture()
      const { access_token: token } = await f.issue()
      expectRefusal(await f.dispatch(token, args, 1, header), 'ORGANIZATION_SELECTION_INVALID')
      expect(f.observedPolicy).not.toHaveBeenCalled()
    },
  )

  it('rejects a combined header even when it exactly matches the designation', async () => {
    const f = fixture()
    const { access_token: token } = await f.issue()
    const headers = new Headers()
    headers.append('X-Org-Id', ORG)
    headers.append('X-Org-Id', OTHER)
    expect(headers.get('X-Org-Id')).toBe(`${ORG}, ${OTHER}`)
    const response = await f.fetchMcp(
      token,
      call(1, { organizationId: `${ORG}, ${OTHER}` }),
      1,
      headers,
    )
    expect(response.status).toBe(200)
    expectRefusal((await response.json()) as Reply, 'ORGANIZATION_SELECTION_INVALID')
  })

  it.each([
    { organizationId: '' },
    { organizationId: ORG, values: Array.from({ length: 1001 }, () => 0) },
  ])('stops at schema or input budget before designation', async (args) => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    expect((await f.dispatch(token, args, 1)).result.isError).toBe(true)
    expect(f.designate).not.toHaveBeenCalled()
    expect(f.observedPolicy).not.toHaveBeenCalled()
    expect(f.observedExecute).not.toHaveBeenCalled()
  })

  it('does not fall back after a denied explicit selection, even for Platform staff', async () => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    expectAllowed(await f.dispatch(token, {}, 2), ORG)
    f.sqlite
      .prepare("INSERT INTO user_platform_roles (user_id, role, updated_at) VALUES (?, 'staff', 0)")
      .run(USER)
    f.removeMember(OTHER)
    f.decodeBusiness.mockClear()
    f.decodePolicy.mockClear()
    f.observedPolicy.mockClear()
    expectRefusal(await f.dispatch(token, { organizationId: OTHER }, 2), 'ORGANIZATION_REFUSED')
    expect(f.decodeBusiness).not.toHaveBeenCalled()
    expect(f.decodePolicy).not.toHaveBeenCalled()
    expect(f.observedPolicy).not.toHaveBeenCalled()
    expect(f.observedExecute.mock.calls).toEqual([[ORG]])
  })

  it('does not scope provider failures, discovery, or an unscoped tool', async () => {
    const f = fixture()
    expect((await f.fetchMcp('rejected-token', call(1), 0)).status).toBe(401)
    const { access_token: token } = await f.issue()
    const list = await f.fetchMcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 1, {
      'X-Org-Id': ',',
    })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'scoped',
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({ organizationId: expect.any(Object) }),
            }),
          }),
        ]),
      },
    })
    const who = await f.fetchMcp(token, call(1, {}, 'who'), 1, { 'X-Org-Id': ',' })
    expect(who.status).toBe(200)
    expect(((await who.json()) as Reply).result.content[0]?.text).toBe(USER)
  })

  it('binds primary batches to the verified tuple and only the current tool declarations', async () => {
    const f = fixture()
    const { access_token: token, clientId, summary } = await f.issue()
    f.grantAdmission.mockClear()
    const response = await f.fetchMcp(
      token,
      [call(1, { organizationId: ORG }), call(2, { organizationId: ORG }, 'sibling')],
      3,
      {
        'X-Org-Id': ORG,
        'X-User-Id': 'forged-user',
        'X-Client-Id': 'forged-client',
        'X-Grant-Id': 'forged-grant',
      },
    )
    expect(response.status).toBe(200)
    const replies = new Map(((await response.json()) as Reply[]).map((reply) => [reply.id, reply]))
    expectAllowed(replies.get(1)!, ORG)
    expect(replies.get(2)?.result).toEqual({ content: [{ type: 'text', text: ORG }] })
    const [outer, scoped, sibling] = f.batches.slice(-3)
    const tuple = [summary.grantId, clientId, USER]
    for (const entry of outer!.slice(0, 3))
      expect(entry.values.slice(0, 4)).toEqual([null, ...tuple])
    expect(outer!.map(({ sql }) => sql)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('JOIN main."organization"')]),
    )
    for (const batch of [scoped!, sibling!]) {
      expect(batch[0]?.sql).toContain('JOIN main."organization"')
      for (const entry of batch.slice(0, -1))
        expect(entry.values.slice(0, 4)).toEqual([ORG, ...tuple])
    }
    const declarations = (batch: Statement[]) =>
      batch
        .filter(({ sql }) => sql.includes('AS fact'))
        .map(({ sql }) => /main\."([^"]+)" AS fact/.exec(sql)?.[1])
    expect(declarations(outer!)).toEqual(['user', 'product_grant_denials'])
    expect(declarations(scoped!)).toEqual([
      'product_policy',
      'organization_roles',
      'product_business',
      'product_grant_denials',
    ])
    expect(declarations(sibling!)).toEqual(['product_grant_denials'])
    expect(f.grantAdmission).toHaveBeenCalledTimes(1)
    expect(f.grantAdmission.mock.calls[0]?.[0]).toEqual({
      phase: 'request',
      userId: USER,
      grantId: summary.grantId,
      clientId,
    })
    expect(f.decodeDeny).not.toHaveBeenCalled()
  })

  it('shares the cap across tools, Organizations and failed reads but not invalid or unscoped calls', async () => {
    const f = fixture()
    const { access_token: token } = await f.issue()
    f.setDriverFailure('throw')
    const siblingCalls = Array.from({ length: 7 }, (_, i) =>
      call(i + 4, { organizationId: i % 2 === 0 ? OTHER : ORG }, 'sibling'),
    )
    const replies = await f.batch(
      token,
      [
        call(1),
        call(2, {}, 'who'),
        call(3, { organizationId: ORG }),
        ...siblingCalls,
        call(11, { organizationId: OTHER }),
      ],
      9,
    )
    const byId = new Map(replies.map((reply) => [reply.id, reply]))
    expect(byId.size).toBe(11)
    expectRefusal(byId.get(1)!, 'ORGANIZATION_SELECTION_INVALID')
    expect(byId.get(2)?.result).toEqual({ content: [{ type: 'text', text: USER }] })
    expectUnavailable(byId.get(3)!)
    for (const id of [4, 6, 8, 10]) {
      expect(byId.get(id)?.result).toEqual({ content: [{ type: 'text', text: OTHER }] })
    }
    for (const id of [5, 7, 9]) {
      expect(byId.get(id)?.result).toEqual({ content: [{ type: 'text', text: ORG }] })
    }
    expectRefusal(byId.get(11)!, 'ORGANIZATION_CALL_LIMIT')
    expect(f.batches.slice(-8).map((batch) => batch[0]?.values[0])).toEqual([
      ORG,
      OTHER,
      ORG,
      OTHER,
      ORG,
      OTHER,
      ORG,
      OTHER,
    ])
    f.setDriverFailure()
    expectAllowed(await f.dispatch(token, { organizationId: ORG }, 2), ORG)
  })

  it('charges an oversized plan to the cap without taking a D1 round trip', async () => {
    const f = fixture({ oversizedPlan: true })
    const { access_token: token } = await f.issue()
    const valid = Array.from({ length: 8 }, (_, index) => call(index + 2, { organizationId: ORG }))
    const replies = await f.batch(token, [call(1, { organizationId: ORG }, 'sibling'), ...valid], 8)
    const byId = new Map(replies.map((reply) => [reply.id, reply]))
    expect(byId.size).toBe(9)
    expectUnavailable(byId.get(1)!)
    for (const { id } of valid.slice(0, 7)) expectAllowed(byId.get(id)!, ORG)
    expectRefusal(byId.get(9)!, 'ORGANIZATION_CALL_LIMIT')
    expect(f.observedExecute).toHaveBeenCalledTimes(7)
  })
})

describe('scoped admission revocation and fact privacy', () => {
  it('checks external grantAdmission on the next request without registering or revoking', async () => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    expectAllowed(await f.dispatch(token, {}, 2), ORG)
    f.observedRegister.mockClear()
    f.observedExecute.mockClear()
    f.grantAdmission.mockResolvedValue(false)
    expect((await f.fetchMcp(token, call(1), 1)).status).toBe(401)
    expect(f.observedRegister).not.toHaveBeenCalled()
    expect(f.observedExecute).not.toHaveBeenCalled()
    expect(await f.helpers.unwrapToken(token)).not.toBeNull()
  })

  it('keeps the registration mode and callback captured at worker creation', async () => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    Object.assign(f.options, { organizationSelection: 'header', register: vi.fn() })
    expectAllowed(await f.dispatch(token, {}, 2), ORG)
  })

  it.each(['suspended', 'archived'])(
    'refuses an Organization when its status becomes %s',
    async (status) => {
      const f = fixture({ defaultOrg: ORG })
      const grant = await f.issue()
      expectAllowed(await f.dispatch(grant.access_token, {}, 2), ORG)
      f.sqlite.prepare('UPDATE organization SET status = ? WHERE id = ?').run(status, ORG)
      expectRefusal(await f.dispatch(grant.access_token, {}, 2), 'ORGANIZATION_REFUSED')
      expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    },
  )

  it.each(['membership', 'disabled user', 'deleted user', 'grant denial'] as const)(
    'observes a %s change during the same batch and does not revoke OAuth',
    async (kind) => {
      const f = fixture()
      const grant = await f.issue()
      if (kind === 'grant denial') {
        f.deny(grant.summary.grantId, 'nonmatching-client')
        f.deny('nonmatching-grant', grant.clientId)
      }
      f.setAfterExecute(() => {
        if (kind === 'membership') f.removeMember(ORG)
        if (kind === 'disabled user')
          f.sqlite.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(USER)
        if (kind === 'deleted user') f.sqlite.prepare('DELETE FROM user WHERE id = ?').run(USER)
        if (kind === 'grant denial') f.deny(grant.summary.grantId, grant.clientId)
      })
      const replies = await f.batch(
        grant.access_token,
        [call(1, { organizationId: ORG }), call(2, { organizationId: ORG })],
        3,
      )
      expectAllowed(replies[0]!, ORG)
      expectRefusal(replies[1]!, 'ORGANIZATION_REFUSED')
      expect(f.observedPolicy).toHaveBeenCalledTimes(1)
      expect(f.decodePolicy).toHaveBeenCalledTimes(1)
      expect(f.decodeBusiness).toHaveBeenCalledTimes(1)
      expect(f.decodeDeny).not.toHaveBeenCalled()
      if (kind === 'membership') {
        expectRefusal(
          await f.dispatch(grant.access_token, { organizationId: ORG }, 2),
          'ORGANIZATION_REFUSED',
        )
      } else {
        expect(
          (await f.fetchMcp(grant.access_token, call(1, { organizationId: ORG }), 1)).status,
        ).toBe(401)
      }
      expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
      if (kind === 'grant denial') {
        const other = await f.issue()
        expectAllowed(await f.dispatch(other.access_token, { organizationId: ORG }, 2), ORG)
      }
    },
  )

  it('observes the assigned Role and its correlated Role record, then provider revocation', async () => {
    const f = fixture({ defaultOrg: ORG })
    const grant = await f.issue()
    f.setPolicy('check-role')
    expectRefusal(await f.dispatch(grant.access_token, {}, 2), 'ORGANIZATION_REFUSED')
    f.sqlite
      .prepare("UPDATE member SET role = 'reader' WHERE organization_id = ? AND user_id = ?")
      .run(ORG, USER)
    expectAllowed(await f.dispatch(grant.access_token, {}, 2), ORG)
    expect(f.observedPolicy).toHaveBeenLastCalledWith({ id: ORG, role: 'reader' })
    expect(f.decodeRole).toHaveBeenCalledWith([{ id: `${ORG}_reader`, key: 'reader' }])
    await f.helpers.revokeGrant(grant.summary.grantId, USER)
    expect((await f.fetchMcp(grant.access_token, call(1, { organizationId: ORG }), 0)).status).toBe(
      401,
    )
  })

  it('runs policy decoders only when operation policy refuses', async () => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    f.setPolicy('refuse')
    const reply = await f.dispatch(token, {}, 2)
    expectRefusal(reply, 'ORGANIZATION_REFUSED')
    expect(JSON.stringify(reply)).not.toContain(POLICY)
    expect(f.decodePolicy).toHaveBeenCalledTimes(1)
    expect(f.decodeBusiness).not.toHaveBeenCalled()
    expect(f.observedExecute).not.toHaveBeenCalled()
  })

  it.each(['overlap', 'policy-scope', 'business-scope'] as const)(
    'rejects %s at declaration time',
    async (invalidRegistration) => {
      const f = fixture({ invalidRegistration })
      const { access_token: token } = await f.issue()
      const response = await f.fetchMcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 1)
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('"scoped"')
      expect(f.registerError).toHaveBeenCalledWith(expect.any(TypeError))
    },
  )

  it('rejects invalid selection mode and worker-level Organization declarations at creation', () => {
    const options: ToolOptions = {
      ...workerOptions,
      organizationSelection: 'tool-input',
      register() {},
    }
    expect(() =>
      createHostedMcpWorker({ ...options, organizationSelection: null as unknown as 'tool-input' }),
    ).toThrow(TypeError)
    expect(() => createHostedMcpWorker({ ...options, facts: [sampleOrgFact] })).toThrow(TypeError)
  })

  it('preserves both Parameters forms of header registration and infers tool-input registration', () => {
    type Header = HostedAuthorization
    type Register = Parameters<typeof createHostedMcpWorker>[0]['register']
    type RegisterForEnv = Parameters<typeof createHostedMcpWorker<HostedMcpEnv>>[0]['register']
    expectTypeOf<Parameters<Register>[1]['authorization']>().toEqualTypeOf<Header>()
    expectTypeOf<Parameters<RegisterForEnv>[1]['authorization']>().toEqualTypeOf<Header>()
    createHostedMcpWorker({
      ...workerOptions,
      organizationSelection: 'tool-input',
      register(_server, { authorization }) {
        expectTypeOf(authorization).toEqualTypeOf<OrganizationToolAuthorization>()
      },
    })
  })

  it('observes a rejecting async policy without an unhandled rejection', async () => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    const reject = async () => {
      throw new Error(CAUSE)
    }
    f.overridePolicy.mockImplementation(reject as unknown as () => boolean)
    await withoutUnhandledRejection(() =>
      expectPrivateUnavailable(token, () => f.dispatch(token, {}, 2)),
    )
    expect(f.observedExecute).not.toHaveBeenCalled()
  })

  it('refuses an async policy fact even when allow catches the error and returns true', async () => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    const caught = vi.fn()
    f.overridePolicy.mockImplementation(({ fact }) => {
      try {
        f.readPolicy(fact)
      } catch (error) {
        caught(error)
      }
      return true
    })
    f.decodePolicy.mockImplementationOnce(async () => {
      throw new Error(CAUSE)
    })
    await withoutUnhandledRejection(() =>
      expectPrivateUnavailable(token, () => f.dispatch(token, {}, 2)),
    )
    expect(caught).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAVAILABLE' }))
    expect(f.decodePolicy).toHaveBeenCalledTimes(1)
    expect(f.observedExecute).not.toHaveBeenCalled()
  })

  it.each([
    ['resolving Promise', (): unknown => Promise.resolve(PRIVATE)],
    ['rejecting Promise', (): unknown => Promise.reject(new Error(CAUSE))],
    [
      'late-rejecting thenable that returns undefined',
      (): unknown => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally simulates a non-Promise thenable
        then(_resolve: unknown, reject: (cause: Error) => void): void {
          void setImmediate().then(() => reject(new Error(CAUSE)))
        },
      }),
    ],
  ] as const)('refuses a business decoder returning a %s', async (_kind, decode) => {
    const f = fixture({ defaultOrg: ORG })
    const { access_token: token } = await f.issue()
    f.decodeBusiness.mockImplementationOnce(decode)
    await withoutUnhandledRejection(() =>
      expectPrivateUnavailable(token, () => f.dispatch(token, {}, 2)),
    )
    expect(f.observedExecute).toHaveBeenCalledExactlyOnceWith(ORG)
    expect(f.decodeBusiness).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'partial', 'malformed'] as const)(
    'fails closed on a %s batch before any policy or handler code',
    async (failure) => {
      const f = fixture({ defaultOrg: ORG })
      const grant = await f.issue()
      f.setDriverFailure(failure)
      await expectPrivateUnavailable(grant.access_token, () =>
        f.dispatch(grant.access_token, {}, 2),
      )
      expect(f.observedExecute).not.toHaveBeenCalled()
      expect(f.decodeBusiness).not.toHaveBeenCalled()
      expect(f.observedPolicy).not.toHaveBeenCalled()
      expect(f.decodePolicy).not.toHaveBeenCalled()
      expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    },
  )

  it.each([
    ['policy throw', 1, 0, 0],
    ['nonboolean', 1, 0, 0],
    ['read-business', 0, 0, 0],
    ['read-policy', 1, 1, 0],
    ['decoder', 1, 1, 1],
  ] as const)(
    'fails closed and does not expose or log private information: %s',
    async (failure, policyDecodes, executions, businessDecodes) => {
      const f = fixture({ defaultOrg: ORG })
      const grant = await f.issue()
      switch (failure) {
        case 'policy throw':
          f.setPolicy('throw')
          break
        case 'nonboolean':
        case 'read-business':
          f.setPolicy(failure)
          break
        case 'read-policy':
          f.setBusinessReadsPolicy()
          break
        case 'decoder':
          f.decodeBusiness.mockImplementationOnce(() => {
            throw new Error(CAUSE)
          })
      }
      await expectPrivateUnavailable(grant.access_token, () =>
        f.dispatch(grant.access_token, {}, 2),
      )
      expect(f.observedExecute).toHaveBeenCalledTimes(executions)
      expect(f.decodeBusiness).toHaveBeenCalledTimes(businessDecodes)
      expect(f.decodePolicy).toHaveBeenCalledTimes(policyDecodes)
      expect(await f.helpers.unwrapToken(grant.access_token)).not.toBeNull()
    },
  )
})

async function withoutUnhandledRejection(run: () => Promise<void>) {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    await run()
    await setImmediate()
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
}

async function expectPrivateUnavailable(token: string, dispatch: () => Promise<Reply>) {
  const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  )
  try {
    const reply = await dispatch()
    expectUnavailable(reply)
    const body = JSON.stringify(reply)
    for (const secret of [PRIVATE, POLICY, CAUSE, token, 'SELECT']) {
      expect(body).not.toContain(secret)
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  } finally {
    for (const log of logs) log.mockRestore()
  }
}
