import {
  OAuthError,
  type OAuthHelpers,
  OAuthProvider,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider'
import { EdgeFastMCP } from 'fastmcp/edge'
import type { McpIdentity } from '../identity'
import { accountAdmissionResponse, accountIsActive } from './account-admission'
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

/**
 * A `fetch`-only handler. A co-located product Worker keeps its other handlers
 * (`queue`, `scheduled`, …): `export default { ...productWorker, fetch: hosted.fetch }`.
 */
export type HostedMcpWorker<Env extends HostedMcpEnv> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
}

export type HostedMcpWorkerOptions<Env extends HostedMcpEnv> = {
  name: string
  version?: string
  /**
   * Called after authentication and optional admission. Tools close over the token
   * identity. `env` has no `OAUTH_PROVIDER`. Not an authorization point.
   */
  register: (server: EdgeFastMCP, call: { identity: McpIdentity; env: Env }) => void
  /** Deny-only admission for an existing OAuth grant. The environment excludes OAUTH_PROVIDER. */
  grantAdmission?: (
    input:
      | { phase: 'request'; userId: string; grantId: string; clientId: string }
      | {
          phase: 'token'
          userId: string
          grantId: string
          clientId: string
          grantType: 'authorization_code' | 'refresh_token'
        },
    env: Env,
  ) => Promise<boolean>
  identityPort: IdentitySource<Env>
  /** Passed verbatim to `identityPort.resolve`. */
  apiBaseUrl: (env: Env, request: Request) => string
  /** Default `always`. Not read from the request. */
  consent?: ConsentPolicy
  /** Static locale and plain-text context for the Kit-owned consent page. */
  consentPresentation?: ConsentPresentation
  /**
   * Omitted means the provider default. Never implied from the access TTL.
   * `0` (no refresh tokens) or an integer of at least 60 seconds; otherwise creation throws.
   */
  refreshTokenTTL?: number
  /** Product routes when the shell fronts the product Worker. Omitted: 404. */
  fallthrough?: Fallthrough<Env>
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
type Admission<Env extends HostedMcpEnv> = NonNullable<
  HostedMcpWorkerOptions<Env>['grantAdmission']
>
type AdmissionInput<Env extends HostedMcpEnv> = Parameters<Admission<Env>>[0]
type AdmissionOutcome = 'allow' | 'deny' | 'unavailable'

async function evaluateAdmission<Env extends HostedMcpEnv>(
  admission: Admission<Env>,
  input: AdmissionInput<Env>,
  env: Env,
): Promise<AdmissionOutcome> {
  try {
    const result = await admission(input, stripOauthHelper(env))
    if (result === true) return 'allow'
    if (result === false) return 'deny'
  } catch {
    // Caller errors, including OAuthError invalid_grant, are never revocation decisions.
  }
  return 'unavailable'
}

async function admitRequest<Env extends HostedMcpEnv>(
  admission: Admission<Env>,
  identity: McpIdentity,
  env: Env,
  ctx: ExecutionContext,
): Promise<AdmissionOutcome> {
  const auth = (
    ctx as ExecutionContext & {
      auth?: { token?: string; userId?: string; clientId?: string }
    }
  ).auth
  if (!(auth?.token && auth.userId && auth.clientId)) return 'deny'
  if (!hasProviderHelper(env)) return 'unavailable'
  try {
    const summary = await env.OAUTH_PROVIDER.unwrapToken(auth.token)
    if (
      !(summary?.userId && summary.grantId && summary.grant.clientId) ||
      summary.userId !== auth.userId ||
      summary.userId !== identity.userId ||
      summary.grant.clientId !== auth.clientId
    )
      return 'deny'
    return evaluateAdmission(
      admission,
      {
        phase: 'request',
        userId: summary.userId,
        grantId: summary.grantId,
        clientId: summary.grant.clientId,
      },
      env,
    )
  } catch {
    return 'unavailable'
  }
}

function admissionResponse(
  outcome: Exclude<AdmissionOutcome, 'allow'>,
  request: Request,
): Response {
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

function tokenAdmission<Env extends HostedMcpEnv>(admission: Admission<Env>) {
  return async ({
    grantType,
    userId,
    grantId,
    clientId,
    env,
  }: TokenExchangeCallbackOptions<Env>) => {
    let outcome: AdmissionOutcome = 'unavailable'
    if (grantType === 'authorization_code' || grantType === 'refresh_token') {
      outcome = await evaluateAdmission(
        admission,
        { phase: 'token', grantType, userId, grantId, clientId },
        env,
      )
    }
    if (outcome === 'deny') {
      throw new OAuthError('invalid_grant', { description: 'Authorization revoked' })
    }
    if (outcome === 'unavailable') {
      throw new OAuthError('temporarily_unavailable', {
        description: 'Grant admission unavailable',
        statusCode: 503,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  }
}

export function createHostedMcpWorker<Env extends HostedMcpEnv>(
  opts: HostedMcpWorkerOptions<Env>,
): HostedMcpWorker<Env> {
  const consent = opts.consent ?? 'always'
  const consentPresentation = snapshotPresentation(opts.consentPresentation)
  const grantAdmission = opts.grantAdmission
  if (grantAdmission !== undefined && typeof grantAdmission !== 'function') {
    throw new TypeError('grantAdmission must be a function')
  }
  const admission: Admission<Env> = async (input, env) => {
    if (!(await accountIsActive(input.userId, env))) return false
    return grantAdmission ? grantAdmission(input, env) : true
  }
  const ttl = opts.refreshTokenTTL
  // The provider checks this when built, per request, where a bad value would fail every route.
  if (ttl !== undefined && ttl !== 0 && !(Number.isInteger(ttl) && ttl >= KV_MIN_TTL_SECONDS)) {
    throw new TypeError(
      `refreshTokenTTL must be 0 or an integer of at least ${KV_MIN_TTL_SECONDS} seconds`,
    )
  }

  const apiHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const identity = normalizeIdentity(ctx.props)
      if (!identity) return new Response('Unauthorized', { status: 401 })
      const outcome = await admitRequest(admission, identity, env, ctx)
      if (outcome !== 'allow') return admissionResponse(outcome, request)
      const server = new EdgeFastMCP({
        name: opts.name,
        version: opts.version ?? '0.0.1',
        mcpPath: MCP_PATH,
      })
      opts.register(server, { identity, env: stripOauthHelper(env) })
      return server.fetch(request)
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
        tokenExchangeCallback: tokenAdmission(admission),
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
