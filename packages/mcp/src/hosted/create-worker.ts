import type { HostedDispatch, HostedDispatchOptions } from '@kit/auth/hosted-dispatch'
import type { EdgeFastMCP } from 'fastmcp/edge'
import type { McpIdentity } from '../identity'
import {
  type ConsentPolicy,
  type ConsentPresentation,
  type Fallthrough,
  type HostedMcpEnv,
  type IdentitySource,
  stripOauthHelper,
} from './env'
import { isReservedPath, mcpPublicOrigin } from './host-policy'
import { snapshotPresentation } from './presentation'
import type { HostedShell } from './shell'
import type { GrantAdmission } from './token-admission'

/**
 * A `fetch`-only handler. A co-located product Worker keeps its other handlers
 * (`queue`, `scheduled`, …): `export default { ...productWorker, fetch: hosted.fetch }`.
 */
export type HostedMcpWorker<Env extends HostedMcpEnv> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
}

/** In-process access to declared App operations, scoped to this MCP request. */
export type HostedToolDispatch = Pick<HostedDispatch, 'fetch'>

export type HostedMcpWorkerOptions<
  Env extends HostedMcpEnv,
  AppEnv extends { Bindings: Env } = { Bindings: Env },
> = {
  name: string
  version?: string
  /** Called after grant admission; `env` excludes OAUTH_PROVIDER. */
  register: (
    server: EdgeFastMCP,
    call: { identity: McpIdentity; env: Env; dispatch?: HostedToolDispatch },
  ) => void
  /** Deny-only admission for an existing OAuth grant. The environment excludes OAUTH_PROVIDER. */
  grantAdmission?: GrantAdmission<Env>
  identityPort: IdentitySource<Env>
  /** Passed verbatim to `identityPort.resolve`. */
  apiBaseUrl: (env: Env, request: Request) => string
  /** Default `always`. Not read from the request. */
  consent?: ConsentPolicy
  /** Static text and bounded branding for the Kit-owned consent page. */
  consentPresentation?: ConsentPresentation
  /**
   * Omitted means the provider default. Never implied from the access TTL.
   * `0` (no refresh tokens) or an integer of at least 60 seconds; otherwise creation throws.
   */
  refreshTokenTTL?: number
  /** Product routes when the shell fronts the product Worker. Omitted: 404. */
  fallthrough?: Fallthrough<Env>
  /** Supply the served Hono App and its Kit authorization instance together. */
  app?: HostedDispatchOptions<AppEnv>['app']
  authorization?: HostedDispatchOptions<AppEnv>['authorization']
}

/** Cloudflare KV's minimum expiration window; the provider refuses a shorter refresh TTL. */
const KV_MIN_TTL_SECONDS = 60

export function createHostedMcpWorker<
  Env extends HostedMcpEnv,
  AppEnv extends { Bindings: Env } = { Bindings: Env },
>(opts: HostedMcpWorkerOptions<Env, AppEnv>): HostedMcpWorker<Env> {
  const consent = opts.consent ?? 'always'
  const consentPresentation = snapshotPresentation(opts.consentPresentation)
  const grantAdmission = opts.grantAdmission
  if (grantAdmission !== undefined && typeof grantAdmission !== 'function') {
    throw new TypeError('grantAdmission must be a function')
  }
  const { app, authorization, register } = opts
  if (Boolean(app) !== Boolean(authorization)) {
    throw new TypeError('app and authorization must be configured together')
  }
  const ttl = opts.refreshTokenTTL
  // The provider checks this when built, per request, where a bad value would fail every route.
  if (ttl !== undefined && ttl !== 0 && !(Number.isInteger(ttl) && ttl >= KV_MIN_TTL_SECONDS)) {
    throw new TypeError(
      `refreshTokenTTL must be 0 or an integer of at least ${KV_MIN_TTL_SECONDS} seconds`,
    )
  }
  const settings = { app, authorization, consent, consentPresentation, grantAdmission, register }
  let shell: HostedShell<Env> | undefined

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      // The shell only ever answers reserved paths, so a product route neither loads its
      // OAuth and MCP code nor builds a provider, on any origin and with any configuration.
      if (!isReservedPath(url.pathname)) {
        if (!opts.fallthrough) return new Response('Not found', { status: 404 })
        return opts.fallthrough(request, stripOauthHelper(env), ctx)
      }
      const pinned = mcpPublicOrigin(env, url)
      if ('error' in pinned) return new Response(pinned.error, { status: 500 })
      // The provider is built for the configured origin only. Any other origin a request names
      // (cleartext, a preview host, a forged Host) has no shell.
      if (pinned.origin !== url.origin) return new Response('Not found', { status: 404 })
      // Taken on arrival, as when the provider was built before any await: the import yields.
      const arrival = {
        origin: pinned.origin,
        name: opts.name,
        refreshTokenTTL: opts.refreshTokenTTL,
      }
      const requestEnv = { ...env }
      if (!shell) {
        // Dynamic on purpose: evaluating the shell is the startup cost product routes skip.
        const { createHostedShell } = await import('./shell')
        shell ??= createHostedShell(opts, settings)
      }
      return shell.fetch(request, requestEnv, ctx, arrival)
    },
  }
}
