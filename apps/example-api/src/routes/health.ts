import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { allowPublicSignup, environmentName, isDevLikeEnvironment } from '../lib/session-env'
import { TENANCY_PASSWORD, TENANCY_PERSONAS } from '../seed/tenancy-data'
import type { AppEnv } from '../types'

/** Primary dogfood login for local BA (staff multi-org). */
const DEMO_STAFF =
  TENANCY_PERSONAS.find((p) => p.email.startsWith('staff@')) ?? TENANCY_PERSONAS[1]!

const healthSchema = z
  .object({
    ok: z.literal(true),
    service: z.string(),
    requestId: z.string(),
    environment: z.string(),
    /** Session stack — always Better Auth (ADR-0002). */
    authAdapter: z.literal('better-auth'),
    /**
     * Public BA email sign-up (SPA `/sign-up`). Fail-closed unless
     * `ALLOW_PUBLIC_SIGNUP=true` — products opt in via env, not a kit default.
     */
    allowPublicSignup: z.boolean(),
    /**
     * Tag of the Worker version serving this request (`wrangler deploy --tag <commit SHA>`), read
     * from the `CF_VERSION_METADATA` binding; null without that binding or tag. Deploy verify
     * compares it with the promoted commit (docs/kit/deploy-verify.md).
     */
    versionTag: z.string().nullable(),
    demoLogin: z
      .object({
        email: z.string(),
        password: z.string(),
        role: z.string(),
      })
      .optional(),
  })
  .openapi('Health')

export const healthRoutes = new OpenAPIHono<AppEnv>()

const getHealth = createRoute({
  method: 'get',
  path: '/health',
  tags: ['health'],
  summary: 'Liveness and environment flags (public)',
  responses: {
    200: {
      description: 'Service is up. `demoLogin` is present only in development|test',
      content: { 'application/json': { schema: healthSchema } },
    },
  },
})

healthRoutes.openapi(getHealth, (c) => {
  const environment = environmentName(c.env) ?? 'unknown'
  const body: z.infer<typeof healthSchema> = {
    ok: true,
    service: 'example-api',
    requestId: c.get('requestId'),
    environment,
    authAdapter: 'better-auth',
    allowPublicSignup: allowPublicSignup(c.env),
    versionTag: c.env.CF_VERSION_METADATA?.tag || null,
  }

  // Kit local DX only — public /health; never returned in staging/production.
  if (isDevLikeEnvironment(c.env)) {
    body.demoLogin = {
      email: DEMO_STAFF.email,
      password: DEMO_STAFF.password || TENANCY_PASSWORD,
      role: DEMO_STAFF.platformRole ?? 'staff',
    }
  }

  // Never cached: Deploy verify must read the version that serves this request.
  c.header('Cache-Control', 'no-store')
  return c.json(body)
})
