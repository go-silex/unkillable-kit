import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

// Run before the provider's query hook. This guides sign-in UX, not session freshness.
export const oidcFreshLoginGuard = {
  id: 'kit-oidc-fresh-login-guard',
  hooks: {
    before: [
      {
        matcher: (ctx) => ctx.path === '/sign-in/magic-link' || ctx.path === '/sign-in/social',
        handler: createAuthMiddleware(async (ctx) => {
          const query = ctx.body?.oauth_query
          if (query === undefined) return
          if (typeof query !== 'string') {
            throw new APIError('BAD_REQUEST', {
              code: 'OIDC_INVALID_OAUTH_QUERY',
              message: 'oauth_query must be a string.',
            })
          }
          const params = new URLSearchParams(query)
          const loginPrompt = params
            .get('prompt')
            ?.split(' ')
            .some((prompt) => prompt.trim() === 'login')
          if (!(loginPrompt || params.has('max_age'))) return
          // Leave invalid signatures to the provider's existing error handling.
          if (!(await verifyOAuthQueryParams(query, ctx.context.secret))) return
          throw new APIError('BAD_REQUEST', {
            code: 'OIDC_PASSWORD_REQUIRED',
            message: 'Use password sign-in for this authorization request.',
          })
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin
