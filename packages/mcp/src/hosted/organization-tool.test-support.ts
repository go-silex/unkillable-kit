import {
  type AuthorizationFact,
  type AuthorizationRow,
  defineAuthorizationFact,
} from '@kit/auth/snapshot'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import { createToolCatalogue } from '../catalogue'
import { createAuthFixture } from './auth-fixture.test-support'
import type { HostedMcpEnv } from './env'
import { createHostedMcpWorker, type HostedMcpWorkerOptions } from './index'
import { createOAuthFixture, ORIGIN, USER } from './oauth-fixture.test-support'
import { CAUSE, observeOrganizationDb } from './organization-db.test-support'

export const ORG = 'org_selected'
export const OTHER = 'org_other'
export const PRIVATE = 'private_business_value'
export const POLICY = 'private_policy_value'
const text = (rows: readonly AuthorizationRow[]) => z.string().parse(rows[0]?.label)
const input = z
  .object({ organizationId: z.string().min(1).optional(), values: z.array(z.number()).optional() })
  .strict()

type Policy = 'accept' | 'refuse' | 'throw' | 'nonboolean' | 'read-business' | 'check-role'
export type ToolOptions = HostedMcpWorkerOptions<HostedMcpEnv, 'tool-input'>

export const workerOptions = {
  name: 'organization-tool-test',
  identityPort: { resolve: async () => ({ userId: USER, email: 'demo@kit.local' }) },
  apiBaseUrl: () => 'http://127.0.0.1:8787',
  consent: { mode: 'demo-loopback', email: 'demo@kit.local' },
} satisfies Pick<ToolOptions, 'name' | 'identityPort' | 'apiBaseUrl' | 'consent'>

const accountFact = defineAuthorizationFact({
  table: { name: 'user', columns: ['id', 'name'] },
  scope: { kind: 'user', userId: 'id' },
  select: ['name'],
  decode: (rows) => rows[0]?.name,
})

function orgFact<T>(name: string, decode: (rows: readonly AuthorizationRow[]) => T) {
  return defineAuthorizationFact({
    table: { name, columns: ['organization_id', 'label'] },
    scope: { kind: 'organization', organizationId: 'organization_id' },
    select: ['label'],
    decode,
  })
}

export const sampleOrgFact: AuthorizationFact<string> = orgFact('product_business', text)

type Call = {
  jsonrpc: '2.0'
  id: number
  method: 'tools/call'
  params: { name: string; arguments: Record<string, unknown> }
}

export function call(id: number, args: Record<string, unknown> = {}, name = 'scoped'): Call {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

export type Reply = {
  id: number
  result: {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content: { type: 'text'; text: string }[]
  }
}

export function fixture({
  defaultOrg,
  invalidRegistration,
}: {
  defaultOrg?: string
  invalidRegistration?: 'overlap' | 'policy-scope' | 'business-scope'
} = {}) {
  const { sqlite, db } = createAuthFixture(USER)
  const { budget, batches, setDriverFailure } = observeOrganizationDb(db)
  let policy: Policy = 'accept'
  let businessFailure = false
  let businessReadsPolicy = false
  let afterExecute: (() => void) | undefined
  const decodePolicy = vi.fn(text)
  const decodeBusiness = vi.fn((rows: readonly AuthorizationRow[]) => {
    if (businessFailure) throw new Error(CAUSE)
    return text(rows)
  })
  const decodeDeny = vi.fn(() => {
    throw new Error(CAUSE)
  })
  const decodeRole = vi.fn((rows: readonly AuthorizationRow[]) => rows[0]?.key)
  const policyFact = orgFact('product_policy', decodePolicy)
  const businessFact = orgFact('product_business', decodeBusiness)
  const roleFact = defineAuthorizationFact({
    table: { name: 'organization_roles', columns: ['id', 'key'] },
    scope: { kind: 'organization-role', roleId: 'id' },
    select: ['key'],
    decode: decodeRole,
  })
  const denyFact = defineAuthorizationFact({
    table: { name: 'product_grant_denials', columns: ['user_id', 'grant_id', 'client_id'] },
    scope: { kind: 'hosted-grant', userId: 'user_id', grantId: 'grant_id', clientId: 'client_id' },
    select: ['grant_id'],
    decode: decodeDeny,
  })
  sqlite.exec('CREATE TABLE product_policy (organization_id TEXT NOT NULL, label TEXT NOT NULL)')
  sqlite.exec('CREATE TABLE product_business (organization_id TEXT NOT NULL, label TEXT NOT NULL)')
  sqlite.exec(
    'CREATE TABLE product_grant_denials (user_id TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL)',
  )
  for (const org of [ORG, OTHER]) {
    sqlite
      .prepare('INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)')
      .run(org, org, org)
    sqlite
      .prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', 0)",
      )
      .run(`${org}_member`, org, USER)
    sqlite.prepare('INSERT INTO product_policy VALUES (?, ?)').run(org, `${POLICY}:${org}`)
    sqlite.prepare('INSERT INTO product_business VALUES (?, ?)').run(org, `${PRIVATE}:${org}`)
    for (const key of ['member', 'reader']) {
      sqlite
        .prepare(
          'INSERT INTO organization_roles (id, organization_id, key, name, created_at) VALUES (?, ?, ?, ?, 0)',
        )
        .run(`${org}_${key}`, org, key, key)
    }
  }
  const designate = vi.fn((arg: z.output<typeof input>) => arg.organizationId ?? defaultOrg)
  const observedPolicy = vi.fn<(organization: { id: string; role: string }) => void>()
  const observedExecute = vi.fn<(id: string) => void>()
  const registerError = vi.fn<(error: unknown) => void>()
  const grantAdmission = vi.fn<NonNullable<ToolOptions['grantAdmission']>>(async () => true)
  const hosted = createHostedMcpWorker({
    ...workerOptions,
    organizationSelection: 'tool-input',
    facts: [accountFact],
    denyFact,
    grantAdmission,
    register(server, { authorization }) {
      expect(authorization).not.toHaveProperty('forOrganization')
      const siblings = [
        {
          name: 'who',
          description: 'Unscoped tool',
          input: z.object({}),
          execute: async () => authorization.fact(accountFact),
        },
        authorization.organizationTool({
          name: 'sibling',
          description: 'Independent scope',
          input,
          organizationId: (arg) => arg.organizationId,
          allow: () => true,
          execute: async (_arg, { organizationId }) => organizationId,
        }),
      ]
      try {
        const scoped = authorization.organizationTool({
          name: 'scoped',
          description: 'Uses two kinds of scoped fact',
          input,
          organizationId: designate,
          policyFacts: [
            invalidRegistration === 'policy-scope' ? accountFact : policyFact,
            roleFact,
          ],
          facts: [
            invalidRegistration === 'overlap'
              ? policyFact
              : invalidRegistration === 'business-scope'
                ? accountFact
                : businessFact,
          ],
          allow({ organization, fact }) {
            observedPolicy(organization)
            if (policy === 'read-business') fact(businessFact)
            const visible = fact(policyFact) === `${POLICY}:${organization.id}`
            if (policy === 'throw') throw new Error(CAUSE)
            if (policy === 'nonboolean') return 'true' as unknown as boolean
            if (policy === 'check-role')
              return organization.role === 'reader' && fact(roleFact) === 'reader'
            return policy === 'accept' && visible
          },
          async execute(_arg, { organizationId, fact }) {
            observedExecute(organizationId)
            if (businessReadsPolicy) fact(policyFact)
            const data = fact(businessFact)
            afterExecute?.()
            return { organizationId, data }
          },
        })
        createToolCatalogue([...siblings, scoped]).registerAll(server)
      } catch (error) {
        if (!invalidRegistration) throw error
        registerError(error)
        createToolCatalogue(siblings).registerAll(server)
      }
    },
  })
  const oauth = createOAuthFixture(hosted, budget.db as unknown as D1Database, budget)
  async function fetchMcp(
    token: string,
    body: unknown,
    count: number,
    headers: Record<string, string> = {},
  ) {
    const before = budget.count
    const response = await oauth.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          ...headers,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
    expect(budget.count - before).toBe(count)
    return response
  }
  async function dispatch(
    token: string,
    args: Record<string, unknown>,
    count: number,
    header?: string,
  ) {
    const reply = await fetchMcp(
      token,
      call(1, args),
      count,
      header === undefined ? {} : { 'X-Org-Id': header },
    )
    expect(reply.status).toBe(200)
    return (await reply.json()) as Reply
  }
  async function batch(token: string, messages: Call[], count: number) {
    const reply = await fetchMcp(token, messages, count)
    expect(reply.status).toBe(200)
    return (await reply.json()) as Reply[]
  }
  return {
    ...oauth,
    sqlite,
    batches,
    fetchMcp,
    dispatch,
    batch,
    observedPolicy,
    observedExecute,
    registerError,
    designate,
    decodePolicy,
    decodeBusiness,
    decodeDeny,
    decodeRole,
    grantAdmission,
    setPolicy: (value: Policy) => {
      policy = value
    },
    setDriverFailure,
    setBusinessFailure: () => {
      businessFailure = true
    },
    setBusinessReadsPolicy: () => {
      businessReadsPolicy = true
    },
    setAfterExecute: (value: () => void) => {
      afterExecute = value
    },
    removeMember: (org: string) =>
      sqlite.prepare('DELETE FROM member WHERE organization_id = ? AND user_id = ?').run(org, USER),
    deny: (grantId: string, clientId: string) =>
      sqlite
        .prepare('INSERT INTO product_grant_denials VALUES (?, ?, ?)')
        .run(USER, grantId, clientId),
  }
}
