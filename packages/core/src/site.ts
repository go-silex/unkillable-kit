import { ErrorCode } from '@kit/types'
import { AppError, newRequestId, toApiErrorBody } from './errors'

/** Structural Static Assets binding: Cloudflare's `Fetcher` satisfies it. */
export type SiteAssets = { fetch(request: Request): Promise<Response> }

export type SiteFetchOptions<Env, Context> = {
  /** Receives API paths, and every request when no assets binding is present. */
  api: (request: Request, env: Env, context: Context) => Response | Promise<Response>
  /** The web build bound as Static Assets, with `not_found_handling = "none"`. */
  assets: (env: Env) => SiteAssets | null | undefined
  /** API-owned paths, given the path decoded once. Default: `/api`, `/api/*`, `/health`, any case. */
  isApiPath?: (decodedPath: string) => boolean
  /** Prefix of built files: a miss under it stays a 404, never the shell. Default `/assets/`. */
  assetPrefix?: string
  /** Set on HTML responses from the binding after the baseline headers, e.g. a CSP. */
  shellHeaders?: HeadersInit
}

const defaultIsApiPath = (path: string) => {
  const lower = path.toLowerCase()
  return lower === '/api' || lower.startsWith('/api/') || lower === '/health'
}

/**
 * One Worker for an API and its SPA. API paths (and undecodable paths) go to `api`; other
 * GET/HEAD requests go to the assets binding without their query string; a miss serves the
 * shell (`/`) only for a navigation outside `assetPrefix`. Without a binding, `api` gets all.
 */
export function createSiteFetch<Env, Context>({
  api,
  assets,
  isApiPath = defaultIsApiPath,
  assetPrefix = '/assets/',
  shellHeaders,
}: SiteFetchOptions<Env, Context>) {
  return async (request: Request, env: Env, context: Context): Promise<Response> => {
    const binding = assets(env)
    if (!binding) return api(request, env, context)

    const url = new URL(request.url)
    let path: string
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      return api(request, env, context)
    }
    if (isApiPath(path)) return api(request, env, context)
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed()

    // One-time tokens travel in page queries; Static Assets match on the path only.
    url.search = ''
    let response = await binding.fetch(new Request(url, request))
    if (response.status === 404 && !path.startsWith(assetPrefix) && isNavigation(path, request)) {
      url.pathname = '/'
      response = await binding.fetch(new Request(url, request))
    }
    return isHtml(response) ? withShellHeaders(response, shellHeaders) : response
  }
}

function isNavigation(path: string, request: Request): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  return !lastSegment.includes('.') || accept.includes('text/html')
}

function isHtml(response: Response): boolean {
  if (response.status === 304) return false
  return response.headers.get('content-type')?.toLowerCase().includes('text/html') ?? false
}

function withShellHeaders(response: Response, shellHeaders: HeadersInit | undefined): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-cache')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  new Headers(shellHeaders).forEach((value, key) => {
    headers.set(key, value)
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function methodNotAllowed(): Response {
  const error = new AppError(ErrorCode.VALIDATION_ERROR, 'Method not allowed', 405)
  const { body, status } = toApiErrorBody(error, newRequestId())
  return Response.json(body, { status, headers: { Allow: 'GET, HEAD' } })
}
