import { isLoopbackHostname } from '../loopback-host'

export { isLoopbackHostname } from '../loopback-host'

/** Access token lifetime (~8h). Refresh TTL is a caller parameter, not a package default. */
export const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60

export const MCP_SCOPE = 'mcp'

export const AUTHORIZE_PATH = '/authorize'
export const TOKEN_PATH = '/token'
export const REGISTER_PATH = '/register'
export const MCP_PATH = '/mcp'

const RESERVED_EXACT = new Set([AUTHORIZE_PATH, TOKEN_PATH, REGISTER_PATH])

function isProductionShaped(env: { ENVIRONMENT?: string }, url: URL): boolean {
  const name = env.ENVIRONMENT?.trim().toLowerCase()
  if (name === 'production' || name === 'staging') return true
  return !isLoopbackHostname(url.hostname)
}

/** Open DCR only on localhost/dev — never a public registrar. */
export function allowDynamicClientRegistration(env: { ENVIRONMENT?: string }, url: URL): boolean {
  return !isProductionShaped(env, url)
}

/**
 * The one origin OAuth is served on, pinned like Better Auth's `BETTER_AUTH_URL`: tokens and
 * metadata are bound to it, so it never comes from a request off a loopback development host.
 * A configured value must be an https origin, or http on a loopback host; otherwise, and when
 * it is unset where it is required, the result names the configuration error.
 */
export function mcpPublicOrigin(
  env: { ENVIRONMENT?: string; MCP_PUBLIC_URL?: string },
  requestUrl: URL,
): { origin: string } | { error: string } {
  const configured = env.MCP_PUBLIC_URL?.trim()
  if (!configured) {
    return isProductionShaped(env, requestUrl)
      ? { error: 'MCP_PUBLIC_URL is required off a loopback development host' }
      : { origin: requestUrl.origin }
  }
  const url = URL.canParse(configured) ? new URL(configured) : null
  const servable =
    url?.protocol === 'https:' || (url?.protocol === 'http:' && isLoopbackHostname(url.hostname))
  if (!(url && servable) || url.href.replace(/\/$/, '') !== url.origin) {
    return { error: 'MCP_PUBLIC_URL must be an https origin (http only on loopback)' }
  }
  return { origin: url.origin }
}

/**
 * Auto-approve only the one caller-declared email, and only on a loopback
 * non-production host. The package does not name a demo user.
 */
export function shouldAutoApproveConsent(opts: {
  env: { ENVIRONMENT?: string }
  requestUrl: URL
  email?: string
  allowEmail: string
}): boolean {
  const allowed = opts.allowEmail.trim().toLowerCase()
  if (!allowed) return false
  if (isProductionShaped(opts.env, opts.requestUrl)) return false
  if (!isLoopbackHostname(opts.requestUrl.hostname)) return false
  return (opts.email ?? '').trim().toLowerCase() === allowed
}

/**
 * A URL `client_id` is self-declared (CIMD fetches its metadata from that URL).
 * Clients the product registered carry provider-generated ids, never URLs.
 */
export function isUrlClientId(clientId: string): boolean {
  try {
    const { protocol } = new URL(clientId)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Paths the shell owns in a co-located Worker, including encoded, trailing-slash
 * and doubled-slash forms that a decoding router would map onto them.
 */
export function isReservedPath(pathname: string): boolean {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return true
  }
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return (
    path.startsWith(MCP_PATH) || RESERVED_EXACT.has(path) || path.startsWith('/.well-known/oauth-')
  )
}

/**
 * Grant `mcp` only. A requested scope other than `mcp` is refused.
 * An empty request stays empty so dogfood authorize URLs that omit scope keep working.
 */
export function grantedScope(requested: readonly string[]): string[] | null {
  if (requested.some((scope) => scope !== MCP_SCOPE)) return null
  return requested.includes(MCP_SCOPE) ? [MCP_SCOPE] : [...requested]
}
