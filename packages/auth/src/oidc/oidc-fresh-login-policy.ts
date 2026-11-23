import type { AuthContext, GenericEndpointContext } from '@better-auth/core'
import { getOAuthProviderState, verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import type { KitD1Database } from '@kit/db'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { trackAuthorizationResponses } from './oidc-authorization-response'
import {
  type Authorization,
  authorizePath,
  capsuleField,
  createOidcProvenance,
  freshnessFrom,
  signedQuery,
} from './oidc-fresh-login-provenance'
import { requiresPasswordSignIn, supportedPrompts } from './oidc-prompt-create'
import { createOidcSessionAuthentication } from './oidc-session-authentication'

const consentPath = '/oauth2/consent'
const passwordPath = '/sign-in/email'
const signupPath = '/sign-up/email'

function invalidRequest() {
  return new APIError('BAD_REQUEST', { error: 'invalid_request' })
}

type Verification = {
  type?: unknown
  query?: Record<string, unknown>
  sessionId?: unknown
  userId?: unknown
  authTime?: unknown
}

type Query = Record<string, unknown>
type MintFields = {
  query: Query
  capsule: string
  identity: { id: string; userId: string; authTime: number }
}

function parseVerification(raw: string): Verification | null {
  try {
    return JSON.parse(raw)
  } catch {
    // Non-code verifications may be opaque.
    return null
  }
}

function mintFields(value: Verification | null): MintFields {
  if (value?.type !== 'authorization_code' || !value.query || typeof value.query !== 'object')
    throw invalidRequest()
  const { query, sessionId: id, userId, authTime } = value
  const capsule = query[capsuleField]
  if (
    typeof id !== 'string' ||
    typeof userId !== 'string' ||
    typeof authTime !== 'number' ||
    !Number.isSafeInteger(authTime) ||
    authTime <= 0 ||
    typeof capsule !== 'string'
  )
    throw invalidRequest()
  return { query, capsule, identity: { id, userId, authTime } }
}

function classifyEntry(ctx: GenericEndpointContext, started?: number): Query {
  const settings = (ctx as GenericEndpointContext & { authorizeSettings?: object })
    .authorizeSettings
  if ((settings === undefined) !== (started !== undefined)) throw invalidRequest()
  const query = started !== undefined && ctx.method === 'POST' ? ctx.body : ctx.query
  if (!query) throw invalidRequest()
  return query
}

function requireInteraction(query: Query, prompt: string[]) {
  if (prompt.includes('none')) query.max_age = '0'
  else if (!prompt.includes('login')) query.prompt = [...prompt, 'login'].join(' ')
}

function clearSatisfiedPrompts(query: Query, prompt: string[]) {
  const remaining = prompt.filter((value) => value !== 'login')
  if (remaining.length) query.prompt = remaining.join(' ')
  else delete query.prompt
  delete query.max_age
}

function isAlternateSignIn(path?: string) {
  return path === '/sign-in/magic-link' || path === '/sign-in/social'
}

export function createOidcFreshLoginPolicy(db: KitD1Database, loginPage: string) {
  const provenance = createOidcProvenance()
  const sessions = createOidcSessionAuthentication(db)
  const { deny, restart, trackMint, hasTrackedMint, protectResponse } =
    trackAuthorizationResponses(db)

  function preflightQuery(ctx: GenericEndpointContext, alternate: boolean): string | undefined {
    const raw = ctx.body.oauth_query
    if (typeof raw === 'string') return raw
    if (alternate) {
      throw new APIError('BAD_REQUEST', {
        code: 'OIDC_INVALID_OAUTH_QUERY',
        message: 'oauth_query must be a string.',
      })
    }
    if (ctx.path === passwordPath || ctx.path === signupPath) throw restart(ctx.request)
  }

  async function checkMint(fields: MintFields, { baseURL, secret }: AuthContext) {
    if (fields.capsule !== (await provenance.pinned.get())) throw invalidRequest()
    const authorization = await provenance.read(fields.query, baseURL, secret)
    if (!(authorization && (await sessions.qualifies(fields.identity, authorization))))
      throw invalidRequest()
    return authorization
  }

  async function verifyCode(
    row: { value: string; identifier: string },
    ctx: GenericEndpointContext | null,
  ) {
    const value = parseVerification(row.value)
    if (ctx?.path !== authorizePath && value?.type !== 'authorization_code') return
    try {
      if (!ctx) throw invalidRequest()
      const authorization = await checkMint(mintFields(value), ctx.context)
      if (!(ctx.request && authorization.freshness)) return
      if (!trackMint(ctx.request, row.identifier)) throw invalidRequest()
    } catch (error) {
      deny(ctx?.request)
      throw error
    }
  }

  async function issueCapsule(query: Query, context: AuthContext, started: number) {
    const { baseURL, secret, secretConfig } = context
    const freshness = freshnessFrom(query)
    if (freshness === undefined) throw invalidRequest()
    const capsule = await provenance.issue(query, baseURL, secret, started, freshness, secretConfig)
    if (!capsule) throw invalidRequest()
    query[capsuleField] = capsule
  }

  async function stepUp(
    ctx: GenericEndpointContext,
    query: Query,
    authorization: Authorization,
    direct: boolean,
  ) {
    if (!authorization.freshness) return
    const prompt = supportedPrompts(query)
    if (!prompt) return
    const { authCookies, secret, session } = ctx.context
    const selected = session?.session
    const token = selected
      ? undefined
      : (await ctx.getSignedCookie(authCookies.sessionToken.name, secret)) || undefined
    const mustInteract = direct && authorization.freshness.sinceStart
    if (mustInteract || !(await sessions.qualifies({ id: selected?.id, token }, authorization))) {
      deny(ctx.request)
      requireInteraction(query, prompt)
      return
    }
    clearSatisfiedPrompts(query, prompt)
  }

  async function readProviderContinuation(raw: string, ctx: GenericEndpointContext) {
    const providerState = await getOAuthProviderState()
    const query = signedQuery(raw)
    if (!(query && providerState?.query)) throw restart(ctx.request)
    const { baseURL, secret } = ctx.context
    const authorization = await provenance.read(query, baseURL, secret)
    if (!authorization) throw restart(ctx.request)
    return authorization
  }

  async function consentNeedsLogin(ctx: GenericEndpointContext, authorization: Authorization) {
    const { authCookies, internalAdapter, secret } = ctx.context
    const token = await ctx.getSignedCookie(authCookies.sessionToken.name, secret)
    const session = token && (await internalAdapter.findSession(token))
    if (!session || new Date(session.session.expiresAt).getTime() <= Date.now()) return false
    return !(await sessions.qualifies({ id: session.session.id }, authorization))
  }

  const preflight = {
    id: 'kit-oidc-fresh-login-preflight',
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.body?.oauth_query !== undefined &&
            (ctx.path === passwordPath ||
              ctx.path === signupPath ||
              ctx.path === '/oauth2/continue' ||
              isAlternateSignIn(ctx.path) ||
              (ctx.path === consentPath && ctx.body.accept === true)),
          handler: createAuthMiddleware(async (ctx) => {
            const alternate = isAlternateSignIn(ctx.path)
            const raw = preflightQuery(ctx, alternate)
            if (raw === undefined) return
            // The provider's query hook would otherwise reject an expired envelope first.
            const { baseURL, secret } = ctx.context
            const query = signedQuery(raw)
            if (!(query && (await verifyOAuthQueryParams(raw, secret)))) throw restart(ctx.request)
            const authorization = await provenance.read(query, baseURL, secret)
            if (!authorization) throw restart(ctx.request)
            if (alternate && requiresPasswordSignIn(query, authorization)) {
              throw new APIError('BAD_REQUEST', {
                code: 'OIDC_PASSWORD_REQUIRED',
                message: 'Use password sign-in for this authorization request.',
              })
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin

  const enforcement = {
    id: 'kit-oidc-fresh-login-enforcement',
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              after: async (row, ctx) => {
                if (ctx?.path === passwordPath) await sessions.record(row)
              },
            },
          },
          verification: { create: { before: verifyCode } },
        },
      },
    }),
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === authorizePath,
          handler: createAuthMiddleware(async (ctx) => {
            const started = provenance.takeStart(ctx.request)
            try {
              const query = classifyEntry(ctx, started)
              if (started !== undefined) await issueCapsule(query, ctx.context, started)
              const { baseURL, secret } = ctx.context
              const authorization = await provenance.read(query, baseURL, secret)
              const capsule = query[capsuleField]
              if (!authorization || typeof capsule !== 'string') {
                throw restart(started === undefined ? ctx.request : undefined)
              }
              await provenance.pinned.set(capsule)
              await stepUp(ctx, query, authorization, started !== undefined)
            } catch (error) {
              deny(ctx.request)
              throw error
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === consentPath && ctx.body?.accept === true,
          handler: createAuthMiddleware(async (ctx) => {
            const oauthQuery = ctx.body?.oauth_query
            if (typeof oauthQuery !== 'string') return
            const authorization = await readProviderContinuation(oauthQuery, ctx)
            if (!(authorization.freshness && (await consentNeedsLogin(ctx, authorization)))) return
            const target = new URL(loginPage, ctx.context.baseURL)
            target.search = oauthQuery
            return ctx.json({ redirect: true, url: target.toString() })
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => !!ctx.request && hasTrackedMint(ctx.request),
          handler: createAuthMiddleware(async (ctx) => {
            const result = ctx.context.returned
            if (result instanceof APIError && result.statusCode >= 400) deny(ctx.request)
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin

  return { preflight, enforcement, capture: provenance.capture, protectResponse }
}
