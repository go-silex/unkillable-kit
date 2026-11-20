import type { BetterAuthPlugin } from 'better-auth'

/** Factory-facing composition contract; it never imports the optional provider peer. */
export type OidcProviderConfig = {
  waitUntil: (promise: Promise<unknown>) => void
  plugins: (isActive: (userId: string) => Promise<boolean>) => BetterAuthPlugin[]
}

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
    plugins: provider.plugins(isActive),
  }
}
