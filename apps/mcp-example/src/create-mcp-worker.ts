import { createRequestAuthorization } from '@kit/auth/hono'
import { newRequestId, toApiErrorBody } from '@kit/core'
import {
  handleWhoamiFromMcpIdentity,
  type McpIdentityPort,
  PublicToolError,
  toolRefusal,
} from '@kit/mcp'
import { createHostedMcpWorker } from '@kit/mcp/hosted'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from 'zod'
import { createExampleCatalogue } from './catalogue'
import type { McpExampleEnv } from './worker-env'

/** Dogfood exception only. The package default is always-show. */
const DEMO_AUTO_APPROVE_EMAIL = 'demo@kit.local'

type AppEnv = { Bindings: McpExampleEnv }
const ORGANIZATION_PATH = '/api/organization'
const organizationInput = z.object({ organizationId: z.string().min(1) })
const organizationOutput = z.object({ id: z.string(), role: z.string().nullable() })

export function createMcpWorker(opts: { identityPort: McpIdentityPort }) {
  const app = new Hono<AppEnv>()
  const authorization = createRequestAuthorization<AppEnv>({
    db: (c) => c.env.DB,
    auth: () => undefined,
  })
  app.onError((err, c) => {
    const { body, status } = toApiErrorBody(err, newRequestId())
    return c.json(body, status as ContentfulStatusCode)
  })
  authorization.hosted(app, () => {
    app.get(ORGANIZATION_PATH, authorization.requireOrgContext(), (c) => {
      const { id, role } = authorization.view(c).organization!
      return c.json({ id, role })
    })
  })
  return createHostedMcpWorker<McpExampleEnv>({
    app,
    authorization,
    name: 'kit-mcp-example',
    version: '0.0.1',
    consent: { mode: 'demo-loopback', email: DEMO_AUTO_APPROVE_EMAIL },
    identityPort: opts.identityPort,
    apiBaseUrl: (env) => env.API_BASE_URL ?? '',
    register(server, { identity, dispatch }) {
      if (!dispatch) throw new Error('Hosted dispatch is not configured')
      createExampleCatalogue(
        async () => handleWhoamiFromMcpIdentity(identity),
        [
          {
            name: 'organization',
            description: 'Read your membership in the selected organization.',
            input: organizationInput,
            output: organizationOutput,
            effect: 'read',
            execute: async (input) => {
              const { organizationId } = organizationInput.parse(input)
              const response = await dispatch.fetch({
                method: 'GET',
                path: ORGANIZATION_PATH,
                organizationId,
              })
              if (response.status >= 500) throw new PublicToolError('UNAVAILABLE')
              if (!response.ok) return toolRefusal({ code: 'ORGANIZATION_ACCESS_REFUSED' })
              return response.json()
            },
          },
        ],
      ).registerAll(server)
    },
  })
}
