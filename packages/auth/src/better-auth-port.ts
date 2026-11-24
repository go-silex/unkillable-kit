/** Minimal Better Auth session API used by the native handler policy. */
export type BetterAuthLike = {
  api: {
    /** Bypass cookie cache and avoid refreshing expiry while resolving identity. */
    getSession: (opts: {
      headers: Headers
      query?: { disableRefresh?: boolean; disableCookieCache?: boolean }
    }) => Promise<{
      user: { id: string; email?: string | null }
      session: { id: string; expiresAt?: Date | string | null }
    } | null>
  }
}
