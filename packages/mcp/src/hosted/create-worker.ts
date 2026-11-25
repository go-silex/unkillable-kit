import { type OAuthHelpers, OAuthProvider } from '@cloudflare/workers-oauth-provider'
import {
  createHostedDispatch,
  type HostedDispatch,
  type HostedDispatchOptions,
} from '@kit/auth/hosted-dispatch'
import { authorizeHostedPrincipal } from '@kit/auth/snapshot'
import { EdgeFastMCP } from 'fastmcp/edge'
import type { McpIdentity } from '../identity'
import { accountAdmissionResponse } from './account-admission'
import { handleAuthorize } from './authorize'
import {
  type ConsentPolicy,
  type ConsentPresentation,
  type Fallthrough,
  type HostedMcpEnv,
  type IdentitySource,
  identityPortFor,
  stripOauthHelper,
} from './env'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZE_PATH,
  allowDynamicClientRegistration,
  isReservedPath,
  MCP_PATH,
  MCP_SCOPE,
  mcpPublicOrigin,
  REGISTER_PATH,
  TOKEN_PATH,
} from './host-policy'
import { normalizeIdentity } from './identity-props'
import { snapshotPresentation } from './presentation'
import {
  type GrantAdmission,
  type GrantPrincipal,
  runGrantAdmission,
  tokenAdmission,
} from './token-admission'

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

const REGISTER_DENIED = JSON.stringify({ error: 'access_denied' })
/** Cloudflare KV's minimum expiration window; the provider refuses a shorter refresh TTL. */
const KV_MIN_TTL_SECONDS = 60

/** The library writes its helper onto env before `defaultHandler`; the type does not say so. */
function hasProviderHelper<Env extends HostedMcpEnv>(
  env: Env,
): env is Env & { OAUTH_PROVIDER: OAuthHelpers } {
  return 'OAUTH_PROVIDER' in env && Boolean(env.OAUTH_PROVIDER)
}

async function requestPrincipal<Env extends HostedMcpEnv>(
  identity: McpIdentity,
  env: Env,
  ctx: ExecutionContext,
): Promise<
  { status: 'allowed'; principal: GrantPrincipal } | { status: 'denied' | 'unavailable' }
> {
  const auth = (
    ctx as ExecutionContext & {
      auth?: { token?: string; userId?: string; clientId?: string }
    }
  ).auth
  if (!(auth?.token && auth.userId && auth.clientId)) return { status: 'denied' }
  if (!hasProviderHelper(env)) return { status: 'unavailable' }
  try {
    const summary = await env.OAUTH_PROVIDER.unwrapToken(auth.token)
    if (
      !(summary?.userId && summary.grantId && summary.grant.clientId) ||
      summary.userId !== auth.userId ||
      summary.userId !== identity.userId ||
      summary.grant.clientId !== auth.clientId
    )
      return { status: 'denied' }
    return {
      status: 'allowed',
      principal: {
        userId: summary.userId,
        grantId: summary.grantId,
        clientId: summary.grant.clientId,
      },
    }
  } catch {
    return { status: 'unavailable' }
  }
}

function admissionResponse(outcome: 'denied' | 'unavailable', request: Request): Response {
  if (outcome === 'unavailable') {
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource${MCP_PATH}", error="invalid_token", scope="${MCP_SCOPE}"`,
      'Cache-Control': 'no-store',
    },
  })
}

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
  const tokenExchangeCallback = tokenAdmission(grantAdmission)
  const ttl = opts.refreshTokenTTL
  // The provider checks this when built, per request, where a bad value would fail every route.
  if (ttl !== undefined && ttl !== 0 && !(Number.isInteger(ttl) && ttl >= KV_MIN_TTL_SECONDS)) {
    throw new TypeError(
      `refreshTokenTTL must be 0 or an integer of at least ${KV_MIN_TTL_SECONDS} seconds`,
    )
  }

  async function serveMcp(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    identity: McpIdentity,
    admission: HostedDispatchOptions<AppEnv>['admission'],
  ) {
    const server = new EdgeFastMCP({
      name: opts.name,
      version: opts.version ?? '0.0.1',
      mcpPath: MCP_PATH,
    })
    const dispatch =
      app && authorization
        ? createHostedDispatch<AppEnv>({
            admission,
            authorization,
            app,
            env,
            // A synthetic App request does not inherit provider authorization props.
            executionCtx: {
              waitUntil: ctx.waitUntil.bind(ctx),
              passThroughOnException: ctx.passThroughOnException.bind(ctx),
              props: {},
            },
            outer: request,
          })
        : undefined
    try {
      register(server, {
        identity,
        env,
        ...(dispatch ? { dispatch: Object.freeze({ fetch: dispatch.fetch }) } : {}),
      })
      return await server.fetch(request)
    } finally {
      dispatch?.close()
    }
  }

  const apiHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const identity = normalizeIdentity(ctx.props)
      if (!identity) return new Response('Unauthorized', { status: 401 })
      const verified = await requestPrincipal(identity, env, ctx)
      if (verified.status !== 'allowed') return admissionResponse(verified.status, request)
      const { principal } = verified
      const admission = await authorizeHostedPrincipal({ db: env.DB, principal })
      if (admission.status !== 'allowed') return admissionResponse(admission.status, request)
      const callerEnv = stripOauthHelper(env)
      if (grantAdmission) {
        const grant = await runGrantAdmission(
          grantAdmission,
          { phase: 'request', ...principal },
          callerEnv,
        )
        if (grant !== 'allowed') return admissionResponse(grant, request)
      }
      return serveMcp(request, callerEnv, ctx, identity, admission)
    },
  }

  const defaultHandler = {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const path = new URL(request.url).pathname
      if (path === AUTHORIZE_PATH) {
        if (!hasProviderHelper(env)) return new Response('OAuth helper missing', { status: 500 })
        const callerEnv = stripOauthHelper(env)
        return handleAuthorize(request, env, {
          identityPort: identityPortFor(opts.identityPort, callerEnv),
          accountAdmission: (userId) => accountAdmissionResponse(userId, callerEnv),
          apiBaseUrl: opts.apiBaseUrl(callerEnv, request),
          consent,
          ...(consentPresentation ? { consentPresentation } : {}),
        })
      }
      if (path === REGISTER_PATH) {
        return new Response(REGISTER_DENIED, {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (!opts.fallthrough || isReservedPath(path)) {
        return new Response('Not found', { status: 404 })
      }
      return opts.fallthrough(request, stripOauthHelper(env), ctx)
    },
  }

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      const pinned = mcpPublicOrigin(env, url)
      // The provider is built for the configured origin only. Any other origin a request names
      // (cleartext, a preview host, a forged Host) has no shell, and its product routes stay;
      // so do they while the configuration is missing or unusable.
      if ('error' in pinned || pinned.origin !== url.origin) {
        if (!isReservedPath(url.pathname)) return defaultHandler.fetch(request, env, ctx)
        if ('error' in pinned) return new Response(pinned.error, { status: 500 })
        return new Response('Not found', { status: 404 })
      }
      const { origin } = pinned
      const dcr = allowDynamicClientRegistration(env, url)
      const provider = new OAuthProvider<Env>({
        apiRoute: MCP_PATH,
        apiHandler,
        defaultHandler,
        authorizeEndpoint: AUTHORIZE_PATH,
        tokenEndpoint: TOKEN_PATH,
        ...(dcr ? { clientRegistrationEndpoint: REGISTER_PATH } : {}),
        accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
        ...(opts.refreshTokenTTL !== undefined ? { refreshTokenTTL: opts.refreshTokenTTL } : {}),
        // Custom-scheme apps stay a consent-page redirect class (ADR-0015 D5); remote http never is.
        allowPrivateUseRedirectUris: true,
        allowTokenExchangeGrant: false,
        tokenExchangeCallback,
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: [MCP_SCOPE],
        requiredScopes: [MCP_SCOPE],
        resourceMetadata: {
          resource: `${origin}${MCP_PATH}`,
          ...(url.protocol === 'https:' ? { authorization_servers: [origin] } : {}),
          resource_name: opts.name,
        },
      })
      // The library sets env.OAUTH_PROVIDER only when absent. A per-request copy keeps
      // the helper bound to this request's origin instead of the first one served.
      return provider.fetch(request, { ...env }, ctx)
    },
  }
}
