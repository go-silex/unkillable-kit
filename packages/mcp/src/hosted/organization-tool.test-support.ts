import { createRequestAuthorization } from '@kit/auth/hono'
import { newRequestId, toApiErrorBody } from '@kit/core'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { vi } from 'vitest'
import { z } from 'zod'
import { createToolCatalogue, PublicToolError, toolRefusal } from '../index'
import type { HostedMcpWorkerOptions } from './create-worker'
import type { HostedMcpEnv } from './env'
import { type Admission, fixture, USER } from './oauth-fixture.test-support'

export const ORG = 'org_selected'
export const OTHER = 'org_other'
export const UNKNOWN = 'org_unknown'
export const PRIVATE = 'private-handler-data'
export const CAUSE = 'private-D1-failure'

type Env = { Bindings: HostedMcpEnv }
type Dispatch = NonNullable<
  Parameters<HostedMcpWorkerOptions<HostedMcpEnv>['register']>[1]['dispatch']
>
const DISCOVER = { method: 'GET', path: '/discovery' }

export function call(id: number, name = 'scoped', args: unknown = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

export type Reply = {
  id: number
  result: {
    content: { type: string; text: string }[]
    structuredContent?: unknown
    isError?: boolean
  }
}

export function organizationFixture(opts: { defaultOrg?: string; admission?: Admission } = {}) {
  const app = new Hono<Env>()
  const authorization = createRequestAuthorization<Env>({
    db: (c) => c.env.DB,
    auth: () => undefined,
  })
  const entered = vi.fn<(id: string) => void>()
  const discovery = vi.fn<(...observed: unknown[]) => void>()
  const observedInput = vi.fn<(hasSelector: boolean) => void>()
  const input = z.object({ organizationId: z.string().min(1).optional() }).superRefine((value) => {
    observedInput(Object.hasOwn(value, 'organizationId'))
  })
  const designate = vi.fn((value: z.infer<typeof input>) => value.organizationId ?? opts.defaultOrg)
  let captured: Dispatch | undefined
  app.onError((error, c) => {
    const { status, body } = toApiErrorBody(error, newRequestId())
    return c.json(body, status as ContentfulStatusCode)
  })
  authorization.hosted(app, () => {
    app.get('/scope', authorization.requireOrgContext({ allowSuperAdmin: true }), (c) => {
      const { id, role } = authorization.view(c).organization!
      entered(id)
      return c.json({ id, role, data: PRIVATE })
    })
    app.get(DISCOVER.path, authorization.requireAuth, (c) => {
      const view = authorization.view(c)
      discovery(
        view.organization,
        c.req.header('x-org-id'),
        c.req.header('authorization'),
        c.req.header('cookie'),
      )
      // This Product's discovery route returns the sole Organization it offers the User.
      return c.json({ id: view.identity?.subject === USER ? ORG : null })
    })
  })

  const f = fixture(opts.admission, {
    app,
    authorization,
    register(server, registration) {
      if (!registration.dispatch) throw new Error('Missing dispatch')
      const dispatch = registration.dispatch
      captured = dispatch
      async function scope(organizationId: string) {
        return dispatch.fetch({ method: 'GET', path: '/scope', organizationId })
      }
      async function scoped(organizationId: string) {
        const response = await scope(organizationId)
        if (response.status >= 500) throw new PublicToolError('UNAVAILABLE')
        if (!response.ok) return toolRefusal({ code: 'ORGANIZATION_ACCESS_REFUSED' })
        return response.json()
      }
      createToolCatalogue([
        {
          name: 'scoped',
          description: 'Read the designated organization',
          input,
          async execute(args) {
            const id = designate(args as z.infer<typeof input>)
            if (id === undefined) return toolRefusal({ code: 'ORGANIZATION_ACCESS_REFUSED' })
            return scoped(id)
          },
        },
        {
          name: 'discovered',
          description: 'Use the discovered organization',
          input: z.object({}),
          async execute() {
            const response = await dispatch.fetch(DISCOVER)
            if (response.status >= 500) throw new PublicToolError('UNAVAILABLE')
            if (!response.ok) return toolRefusal({ code: 'ORGANIZATION_ACCESS_REFUSED' })
            const { id } = z.object({ id: z.string() }).parse(await response.json())
            return scoped(id)
          },
        },
        {
          name: 'burst',
          description: 'Dispatch concurrently',
          input: z.object({}),
          async execute() {
            const pending = [
              scope(''),
              scope(UNKNOWN),
              dispatch.fetch(DISCOVER),
              ...Array.from({ length: 7 }, (_, i) => scope(i % 2 ? ORG : OTHER)),
            ]
            return Promise.all(pending.map(async (response) => (await response).status))
          },
        },
      ]).registerAll(server)
    },
  })
  for (const id of [ORG, OTHER, UNKNOWN]) {
    f.auth.sqlite
      .prepare('INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)')
      .run(id, id, id)
    if (id !== UNKNOWN) {
      f.auth.sqlite
        .prepare(
          "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', 0)",
        )
        .run(`${id}_member`, id, USER)
    }
  }
  return { ...f, entered, discovery, designate, observedInput, captured: () => captured }
}
