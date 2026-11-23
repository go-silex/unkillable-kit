import type { KitD1Database } from '@kit/db'
import type { BetterAuthPlugin } from 'better-auth'

/** Factory-facing composition contract; it never imports the optional provider peer. */
export type OidcProviderConfig = {
  waitUntil: (promise: Promise<unknown>) => void
  compose: (
    isActive: (userId: string) => Promise<boolean>,
    database: KitD1Database,
  ) => {
    plugins: BetterAuthPlugin[]
    protectResponse?: (
      request: Request,
      next: (request: Request) => Promise<Response>,
    ) => Promise<Response>
  }
}

export function providerComposition(
  provider: OidcProviderConfig | undefined,
  isActive: (userId: string) => Promise<boolean>,
  database: KitD1Database,
) {
  if (!provider)
    return {
      plugins: [],
      disabledPaths: undefined,
      backgroundTasks: undefined,
      protectResponse: undefined,
    }
  return {
    disabledPaths: [
      '/token',
      '/oauth2/create-client',
      '/oauth2/update-client',
      '/oauth2/delete-client',
      '/oauth2/client/rotate-secret',
    ],
    backgroundTasks: { handler: provider.waitUntil },
    ...provider.compose(isActive, database),
  }
}
