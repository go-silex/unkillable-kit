import {
  AuthorizationError,
  type AuthorizationErrorCode,
  type AuthRequest,
  CimdFetchError,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import type { McpIdentity, McpIdentityPort } from '../identity'
import {
  clearConsentCookie,
  consentHtml,
  consentPageHeaders,
  putConsent,
  readConsent,
  sameToken,
} from './consent'
import type { ConsentPolicy, ConsentPresentation, HostedMcpEnv } from './env'
import { grantedScope, isUrlClientId, shouldAutoApproveConsent } from './host-policy'
import { grantMetadata, normalizeIdentity } from './identity-props'
import { isProductRegistered } from './product-registered'

export type AuthorizeEnv = HostedMcpEnv & { OAUTH_PROVIDER: OAuthHelpers }

export type AuthorizeDeps = {
  identityPort: McpIdentityPort
  accountAdmission: (userId: string) => Promise<Response | null>
  apiBaseUrl: string
  consent: ConsentPolicy
  consentPresentation?: ConsentPresentation
}

function authorizationErrorResponse(
  error: AuthorizationError,
  headers?: Record<string, string>,
): Response {
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400, headers })
  }
  const redirect = new URL(error.redirectUri)
  redirect.searchParams.set('error', error.code)
  redirect.searchParams.set('error_description', error.description)
  if (error.state) redirect.searchParams.set('state', error.state)
  if (error.issuer) redirect.searchParams.set('iss', error.issuer)
  return new Response(null, { status: 302, headers: { ...headers, location: redirect.toString() } })
}

/** RFC 6749 §4.1.2.1 error back to the client of a validated request. */
function redirectError(
  request: AuthRequest,
  code: AuthorizationErrorCode,
  description: string,
  headers?: Record<string, string>,
): Response {
  const { redirectUri, state, issuer } = request
  return authorizationErrorResponse(
    new AuthorizationError(code, { description, redirectUri, state, issuer }),
    headers,
  )
}

async function completeAs(
  env: AuthorizeEnv,
  request: AuthRequest,
  scope: string[],
  identity: McpIdentity,
  headers?: Record<string, string>,
): Promise<Response> {
  let redirectTo: string
  try {
    ;({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request,
      userId: identity.userId,
      metadata: grantMetadata(identity),
      scope,
      props: identity,
    }))
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error, headers)
    throw error
  }
  return new Response(null, { status: 302, headers: { ...headers, location: redirectTo } })
}

async function handleConsentPost(
  request: Request,
  env: AuthorizeEnv,
  deps: AuthorizeDeps,
): Promise<Response> {
  const consent = await readConsent(env.OAUTH_KV, request)
  if (!consent) {
    return new Response('Invalid or expired consent', { status: 401 })
  }
  const form = await request.formData().catch(() => null)
  if (!(form && sameToken(String(form.get('csrf') ?? ''), consent.csrf))) {
    return new Response('Invalid consent CSRF', { status: 400 })
  }
  const denied = await deps.accountAdmission(consent.identity.userId)
  if (denied) return denied
  // Best effort: KV has no atomic take, so a replay inside its visibility window
  // can complete again — for this same request, which only its PKCE holder redeems.
  await env.OAUTH_KV.delete(consent.key)
  const clear = { 'set-cookie': clearConsentCookie(new URL(request.url)) }
  if (String(form.get('consent')) !== 'yes') {
    return redirectError(consent.request, 'access_denied', 'The user denied the request', clear)
  }
  return completeAs(env, consent.request, consent.scope, consent.identity, clear)
}

async function renderConsentPage(
  request: Request,
  env: AuthorizeEnv,
  oauthRequest: AuthRequest,
  scope: string[],
  identity: McpIdentity,
  presentation?: ConsentPresentation,
): Promise<Response> {
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId)
  const { csrf, cookie } = await putConsent(env.OAUTH_KV, new URL(request.url), {
    identity,
    request: oauthRequest,
    scope,
  })
  const html = consentHtml({
    clientName: client?.clientName ?? '',
    clientId: oauthRequest.clientId,
    redirectUri: oauthRequest.redirectUri,
    email: identity.email ?? '',
    csrf,
    ...(presentation ? { presentation } : {}),
  })
  return new Response(html, { status: 200, headers: consentPageHeaders(cookie) })
}

/**
 * A URL `client_id` (CIMD, self-declared) always gets the page. `skip` completes
 * only when a positive product-registration receipt is visible for the client.
 * Missing or not-yet-visible receipts show the page (fail closed). Open DCR and
 * bare `OAuthHelpers.createClient` write no receipt. `demo-loopback` is that one
 * email on loopback dev.
 */
async function completesWithoutPage(
  policy: ConsentPolicy,
  env: AuthorizeEnv,
  request: Request,
  clientId: string,
  email?: string,
): Promise<boolean> {
  if (isUrlClientId(clientId)) return false
  if (policy === 'skip') return isProductRegistered(env.OAUTH_KV, clientId)
  if (typeof policy === 'string' || policy.mode !== 'demo-loopback') return false
  const requestUrl = new URL(request.url)
  return shouldAutoApproveConsent({ env, requestUrl, email, allowEmail: policy.email })
}

/**
 * An error that names a redirect target is returned, not answered: it reaches the
 * client only after the user is authenticated (RFC 9700 §4.11.2). Others answer 400 now.
 */
async function parseRequest(
  env: AuthorizeEnv,
  request: Request,
): Promise<AuthRequest | AuthorizationError | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request)
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return error.redirectUri ? error : authorizationErrorResponse(error)
    }
    if (error instanceof CimdFetchError) {
      return new Response('Client metadata document unavailable', { status: 400 })
    }
    throw error
  }
}

export async function handleAuthorize(
  request: Request,
  env: AuthorizeEnv,
  deps: AuthorizeDeps,
): Promise<Response> {
  if (request.method === 'POST') return handleConsentPost(request, env, deps)
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  }
  const parsed = await parseRequest(env, request)
  if (parsed instanceof Response) return parsed
  const resolved = await deps.identityPort.resolve({ request, apiBaseUrl: deps.apiBaseUrl })
  if (resolved instanceof Response) return resolved
  const identity = normalizeIdentity(resolved)
  if (!identity) {
    return new Response('Identity port returned an unusable user id', { status: 500 })
  }
  const denied = await deps.accountAdmission(identity.userId)
  if (denied) return denied
  if (parsed instanceof AuthorizationError) return authorizationErrorResponse(parsed)
  const oauthRequest = parsed
  const scope = grantedScope(oauthRequest.scope)
  if (!scope) {
    return redirectError(oauthRequest, 'invalid_scope', 'Only the mcp scope is granted')
  }
  if (
    await completesWithoutPage(deps.consent, env, request, oauthRequest.clientId, identity.email)
  ) {
    return completeAs(env, oauthRequest, scope, identity)
  }
  return renderConsentPage(request, env, oauthRequest, scope, identity, deps.consentPresentation)
}
