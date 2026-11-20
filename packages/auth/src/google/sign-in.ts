import type { BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import type { GoogleProfile } from 'better-auth/social-providers'

export type GoogleSignInOptions = {
  clientId: string
  clientSecret: string
  allowedDomains: string[]
}

function normalizeDomain(domain: string): string | undefined {
  if (
    !/^[\x20-\x7e]+$/.test(domain) ||
    domain.length > 253 ||
    !domain.includes('.') ||
    !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
    return undefined
  return domain.toLowerCase()
}

export function googleRedirectOnlyPlugins(enabled: boolean) {
  return enabled ? [googleRedirectOnlyPlugin()] : []
}

function googleRedirectOnlyPlugin() {
  return {
    id: 'kit-google-redirect-only',
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string; body?: { provider?: string; idToken?: unknown } }) =>
            ctx.body?.provider === 'google' &&
            (ctx.path === '/link-social' || (ctx.path === '/sign-in/social' && !!ctx.body.idToken)),
          handler: createAuthMiddleware(async () => {
            throw new APIError('BAD_REQUEST', {
              code: 'GOOGLE_REDIRECT_ONLY',
              message: 'Google sign-in requires the redirect flow',
            })
          }),
        },
      ],
    },
  }
}

function createGoogleSignIn(options: GoogleSignInOptions) {
  if (
    !options ||
    typeof options.clientId !== 'string' ||
    !options.clientId.trim() ||
    typeof options.clientSecret !== 'string' ||
    !options.clientSecret.trim() ||
    !Array.isArray(options.allowedDomains) ||
    options.allowedDomains.length === 0
  )
    throw new Error('Invalid Google sign-in configuration')

  const domains = new Set(
    options.allowedDomains.map((domain) => {
      if (typeof domain !== 'string') throw new Error('Invalid Google sign-in domain')
      const normalized = normalizeDomain(domain.trim())
      if (!normalized) throw new Error('Invalid Google sign-in domain')
      return normalized
    }),
  )
  const { clientId, clientSecret } = options
  return {
    clientId,
    clientSecret,
    disableSignUp: true,
    async getUserInfo(tokens: { idToken?: string; expectedIdTokenNonce?: string }) {
      if (!tokens.idToken) return null
      // Older supported Better Auth peers do not export this; load it only for opt-in Google.
      const idToken = tokens.idToken
      const claims = await import('better-auth/social-providers')
        .then(({ verifyGoogleIdToken }) =>
          verifyGoogleIdToken({
            token: idToken,
            audience: clientId,
            nonce: tokens.expectedIdTokenNonce,
          }),
        )
        .catch(() => null)
      if (
        claims?.email_verified !== true ||
        typeof claims.email !== 'string' ||
        typeof claims.hd !== 'string' ||
        typeof claims.sub !== 'string' ||
        !claims.sub
      )
        return null
      const parts = claims.email.split('@')
      const domain = parts[1] && normalizeDomain(parts[1])
      if (
        parts.length !== 2 ||
        !parts[0] ||
        !domain ||
        normalizeDomain(claims.hd) !== domain ||
        !domains.has(domain)
      )
        return null
      return {
        user: {
          email: claims.email,
          emailVerified: true,
          name: typeof claims.name === 'string' ? claims.name : '',
          image: typeof claims.picture === 'string' ? claims.picture : undefined,
        },
        data: claims as unknown as GoogleProfile,
      }
    },
  }
}

export const googleAccountHooks: NonNullable<BetterAuthOptions['databaseHooks']>['account'] = {
  create: {
    before: async (account) =>
      account.providerId === 'google'
        ? {
            data: {
              ...account,
              issuer: 'https://accounts.google.com',
              accessToken: null,
              refreshToken: null,
              idToken: null,
            },
          }
        : undefined,
  },
  update: {
    before: async (account) =>
      account.providerId === 'google' ||
      (!account.providerId &&
        ('accessToken' in account || 'refreshToken' in account || 'idToken' in account))
        ? { data: { ...account, accessToken: null, refreshToken: null, idToken: null } }
        : undefined,
  },
}

function googleUserPolicy(
  findUser: (id: string) => Promise<{ email: string; active: boolean } | undefined>,
): NonNullable<BetterAuthOptions['user']> {
  return {
    validateUserInfo: async ({ user, source }) => {
      if (source.oauth?.providerId !== 'google') return
      const existing = user.id ? await findUser(user.id) : undefined
      if (!existing?.active) return { error: 'account_inactive' }
      if (existing.email.toLowerCase() !== user.email?.toLowerCase()) {
        return { error: 'google_email_mismatch' }
      }
    },
  }
}

export function googleConfiguration(
  options: GoogleSignInOptions | undefined,
  findUser: (id: string) => Promise<{ email: string; active: boolean } | undefined>,
) {
  if (options === undefined) return {}
  return {
    socialProviders: { google: createGoogleSignIn(options) },
    user: googleUserPolicy(findUser),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
        allowDifferentEmails: false,
        disableImplicitLinking: false,
        requireLocalEmailVerified: true,
      },
      additionalFields: {
        issuer: {
          type: 'string' as const,
          required: true,
          defaultValue: 'local:credential',
          input: false,
        },
      },
      updateAccountOnSignIn: false,
    },
  }
}
