import { createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import type { KitBetterAuth } from './better-auth-factory'
import type { OidcProviderConfig } from './oidc-provider'

export function providerComposition(
  provider: OidcProviderConfig | undefined,
  isActive: (userId: string) => Promise<boolean>,
) {
  if (!provider) return { plugins: [] }
  return {
    disabledPaths: [
      '/token',
      '/oauth2/create-client',
      '/oauth2/update-client',
      '/oauth2/delete-client',
      '/oauth2/client/rotate-secret',
    ],
    backgroundTasks: { handler: provider.waitUntil },
    plugins: [...provider.plugins(isActive), createOidcLogoutPlugin()],
  }
}

/** Deletes user sessions inside an auth endpoint so Better Auth's database hooks run. */
export function createOidcLogoutPlugin() {
  return {
    id: 'kit-oidc-logout',
    endpoints: {
      endOidcUserSessions: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({ userId: z.string().min(1) }),
        },
        async (ctx) => {
          await ctx.context.internalAdapter.deleteUserSessions(ctx.body.userId)
          return ctx.json({ success: true })
        },
      ),
    },
  }
}

/** Server-side API surface supplied by an auth instance with the logout plugin. */
export type OidcLogoutAuth = {
  api: {
    endOidcUserSessions: (input: { body: { userId: string } }) => Promise<unknown>
  }
}

/** End all Better Auth sessions for a user, including provider logout hooks. */
export async function endOidcUserSessions(auth: KitBetterAuth, userId: string): Promise<void> {
  await (auth as unknown as OidcLogoutAuth).api.endOidcUserSessions({ body: { userId } })
}
