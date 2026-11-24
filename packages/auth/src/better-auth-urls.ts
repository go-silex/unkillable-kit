import { BA_BASE_PATH } from './better-auth-base-path'

export function apiErrorOptions(google: boolean, origins: string[], configuredURL?: string) {
  let errorURL = new URL('/login', origins[0]).toString()
  if (configuredURL !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(configuredURL)
    } catch {
      throw new Error('googleErrorURL must be an absolute URL on a trusted origin')
    }
    const httpScheme = parsed.protocol === 'https:' || parsed.protocol === 'http:'
    if (!httpScheme || parsed.username || parsed.password || !origins.includes(parsed.origin)) {
      throw new Error('googleErrorURL must be an absolute URL on a trusted origin')
    }
    errorURL = parsed.toString()
  }
  return { throw: true, ...(google ? { errorURL } : {}) }
}

export function authenticationLinkOrigins(
  opts: { baseURL: string; requestDerivedBaseURL?: boolean },
  trustedOrigins: string[],
) {
  const linkOrigins = new Set(trustedOrigins)
  let base: URL
  try {
    base = new URL(opts.baseURL)
  } catch {
    throw new Error('BETTER_AUTH_URL must be an absolute origin')
  }
  if (!opts.requestDerivedBaseURL) linkOrigins.add(base.origin)
  // Better Auth routes on a baseURL path when there is one; the kit throttle matches BA_BASE_PATH.
  const mount = base.pathname.replace(/\/+$/, '')
  if (mount !== '' && mount !== BA_BASE_PATH) {
    throw new Error(`BETTER_AUTH_URL path must be / or ${BA_BASE_PATH}`)
  }
  return [...linkOrigins]
}
