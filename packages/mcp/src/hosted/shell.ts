import { type OAuthHelpers, OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createHostedDispatch, type HostedDispatchOptions } from '@kit/auth/hosted-dispatch'
import { authorizeHostedPrincipal } from '@kit/auth/snapshot'
import { EdgeFastMCP } from 'fastmcp/edge'
import type { McpIdentity } from '../identity'
import { accountAdmissionResponse } from './account-admission'
import { handleAuthorize } from './authorize'
import type { HostedMcpWorkerOptions } from './create-worker'
import { type ConsentPolicy, type HostedMcpEnv, identityPortFor, stripOauthHelper } from './env'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZE_PATH,
  allowDynamicClientRegistration,
  MCP_PATH,
  MCP_SCOPE,
  REGISTER_PATH,
  TOKEN_PATH,
} from './host-policy'
import { normalizeIdentity } from './identity-props'
import type { ResolvedConsentPresentation } from './presentation'
import { type GrantPrincipal, runGrantAdmission, tokenAdmission } from './token-admission'

/** What the factory fixed when the worker was created; the rest is read from its options. */
type HostedShellSettings<Env extends HostedMcpEnv, AppEnv extends { Bindings: Env }> = Pick<
  HostedMcpWorkerOptions<Env, AppEnv>,
  'app' | 'authorization' | 'grantAdmission' | 'register'
> & {
  consent: ConsentPolicy
  consentPresentation: ResolvedConsentPresentation | undefined
}

/** What the router read when the request arrived, before loading the shell. */
type ShellArrival = { origin: string; name: string; refreshTokenTTL: number | undefined }

/** Serves one request on a reserved path of the pinned origin, with a per-request env copy. */
export type HostedShell<Env extends HostedMcpEnv> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext, arrival: ShellArrival): Promise<Response>
}

const REGISTER_DENIED = JSON.stringify({ error: 'access_denied' })

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

/**
 * The OAuth authorization server and `/mcp`. Loaded on the first request to a reserved path of
 * the pinned origin, so product routes never evaluate it; the provider stays per request.
 */
export function createHostedShell<Env extends HostedMcpEnv, AppEnv extends { Bindings: Env }>(
  opts: HostedMcpWorkerOptions<Env, AppEnv>,
  settings: HostedShellSettings<Env, AppEnv>,
): HostedShell<Env> {
  const { app, authorization, consent, consentPresentation, grantAdmission, register } = settings
  const tokenExchangeCallback = tokenAdmission(grantAdmission)

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

  // Only reserved paths reach the provider, so whatever it does not answer itself stays here.
  const defaultHandler = {
    fetch(request: Request, env: Env) {
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
      return new Response('Not found', { status: 404 })
    },
  }

  return {
    fetch(request, env, ctx, { origin, name, refreshTokenTTL }) {
      const url = new URL(request.url)
      const dcr = allowDynamicClientRegistration(env, url)
      const provider = new OAuthProvider<Env>({
        apiRoute: MCP_PATH,
        apiHandler,
        defaultHandler,
        authorizeEndpoint: AUTHORIZE_PATH,
        tokenEndpoint: TOKEN_PATH,
        ...(dcr ? { clientRegistrationEndpoint: REGISTER_PATH } : {}),
        accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
        ...(refreshTokenTTL !== undefined ? { refreshTokenTTL } : {}),
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
          resource_name: name,
        },
      })
      // The library sets env.OAUTH_PROVIDER only when absent. The router's per-request copy
      // keeps the helper bound to this request's origin instead of the first one served.
      return provider.fetch(request, env, ctx)
    },
  }
}
