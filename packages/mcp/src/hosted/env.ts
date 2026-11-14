import type { McpIdentityPort } from '../identity'

export type HostedMcpEnv = {
  OAUTH_KV: KVNamespace
  /** The same D1 database used by the product's Better Auth user table. */
  DB: D1Database
  /** Set it on every deployed compose: `production` / `staging` close DCR and demo auto-approve. */
  ENVIRONMENT?: string
  /**
   * Public origin of the shell: https, or http on a loopback host, e.g. `https://app.example.com`
   * (MCP at `<origin>/mcp`). Required unless the host is loopback and `ENVIRONMENT` is neither
   * `production` nor `staging`. Missing or unusable: the shell paths answer `500`.
   */
  MCP_PUBLIC_URL?: string
}

/**
 * Default is always-show. Caller code, never a request field. A URL `client_id`
 * (CIMD, self-declared) always gets the page.
 * - `skip`: no page only when a positive product-registration receipt is visible
 *   (`createProductClient`). Open DCR and bare `OAuthHelpers.createClient` write
 *   none. A missing or not-yet-visible receipt shows the page (KV eventual
 *   consistency fail-closed). Temporary consent while a just-written receipt
 *   propagates is expected.
 * - `demo-loopback`: no page for that one email, on a loopback non-production
 *   host, for any client registered there. Demo-account risk only.
 */
export type ConsentPolicy = 'always' | 'skip' | { mode: 'demo-loopback'; email: string }

/** Static, plain-text additions to the Kit-owned consent page. */
export type ConsentPresentation = {
  readonly locale?: 'en' | 'fr'
  readonly serviceName?: string
  readonly disclosures?: readonly { readonly label: string; readonly text: string }[]
}

/**
 * Product routes in a co-located Worker. Trusted product code, not a sandbox and
 * not an authorization point: it never sees the shell's paths, and its env has
 * no `OAUTH_PROVIDER` helper. It still holds `OAUTH_KV`, and write access to
 * that namespace can mint grants: hook code is trusted with minting power.
 */
export type Fallthrough<Env extends HostedMcpEnv> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>

/**
 * Object form must not close over a Worker env. Function form is invoked on
 * every request with that request's env and is never cached. Redeem uses
 * `apiBaseUrl`, which the factory passes from the same request.
 */
export type IdentitySource<Env extends HostedMcpEnv> =
  | McpIdentityPort
  | ((env: Env) => McpIdentityPort)

export function identityPortFor<Env extends HostedMcpEnv>(
  source: IdentitySource<Env>,
  env: Env,
): McpIdentityPort {
  return typeof source === 'function' ? source(env) : source
}

/** Drop the provider helper the library writes onto env; `OAUTH_KV` stays (see `Fallthrough`). */
export function stripOauthHelper<Env extends HostedMcpEnv>(env: Env): Env {
  const copy = { ...env }
  Reflect.deleteProperty(copy, 'OAUTH_PROVIDER')
  return copy
}
