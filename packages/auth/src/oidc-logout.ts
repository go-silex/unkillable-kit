import { createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import type { KitBetterAuth } from './better-auth-factory'

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
