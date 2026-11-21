import { ErrorCode } from '@kit/types'
import { AppError, newRequestId, toApiErrorBody } from './errors'

/** Structural Static Assets binding: Cloudflare's `Fetcher` satisfies it. */
export type SiteAssets = { fetch(request: Request): Promise<Response> }

export type SiteFetchOptions<Env, Context> = {
  /** Receives API paths, and every request when no assets binding is present. */
  api: (request: Request, env: Env, context: Context) => Response | Promise<Response>
  /** The web build bound as Static Assets, with `not_found_handling = "none"`. */
  assets: (env: Env) => SiteAssets | null | undefined
  /** API-owned paths, given the normalized path. Default: `/api`, `/api/*`, `/health`, any case. */
  isApiPath?: (path: string) => boolean
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
 * GET/HEAD requests go to the assets binding; a miss serves the shell (`/`) only for a
 * navigation outside `assetPrefix`. Without a binding, `api` receives every request.
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
    const path = binding ? sitePath(request) : undefined
    if (!binding || path === undefined || isApiPath(path)) return api(request, env, context)
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed()
    return serveAsset(binding, request, path, assetPrefix, shellHeaders)
  }
}

/** Static Assets decodes once and collapses repeated slashes: classify that same path. */
function sitePath(request: Request): string | undefined {
  try {
    return decodeURIComponent(new URL(request.url).pathname).replace(/\/{2,}/g, '/')
  } catch {
    return undefined
  }
}

async function serveAsset(
  binding: SiteAssets,
  request: Request,
  path: string,
  assetPrefix: string,
  shellHeaders: HeadersInit | undefined,
): Promise<Response> {
  const underPrefix = path.startsWith(assetPrefix)
  const extensionless = !path.slice(path.lastIndexOf('/') + 1).includes('.')
  const navigation = !underPrefix && (extensionless || acceptsHtml(request))
  // A navigation always gets a full response, so a 304 never replaces the shell headers.
  const assetRequest = navigation ? withoutConditionals(request) : request
  let response = await binding.fetch(assetRequest)
  // On a dotted miss outside the prefix, Accept decides between the 404 and the shell.
  const vary = response.status === 404 && !underPrefix && !extensionless
  if (response.status === 404 && navigation) {
    response = await binding.fetch(new Request(new URL('/', request.url), assetRequest))
  }
  const html = isHtml(response)
  if (!(html || vary)) return response
  const headers = new Headers(response.headers)
  if (html) setShellHeaders(headers, shellHeaders)
  if (vary) headers.append('vary', 'Accept')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').split(',').some((range) => {
    const [type, ...params] = range.split(';').map((part) => part.trim().toLowerCase())
    return type === 'text/html' && !params.some((param) => /^q=0(\.0*)?$/.test(param))
  })
}

function withoutConditionals(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('if-none-match')
  headers.delete('if-modified-since')
  return new Request(request, { headers })
}

function isHtml(response: Response): boolean {
  if (response.status === 304) return false
  return response.headers.get('content-type')?.toLowerCase().includes('text/html') ?? false
}

function setShellHeaders(headers: Headers, shellHeaders: HeadersInit | undefined): void {
  headers.set('cache-control', 'no-cache')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  new Headers(shellHeaders).forEach((value, key) => {
    headers.set(key, value)
  })
}

function methodNotAllowed(): Response {
  const requestId = newRequestId()
  const error = new AppError(ErrorCode.VALIDATION_ERROR, 'Method not allowed', 405)
  const { body, status } = toApiErrorBody(error, requestId)
  return Response.json(body, {
    status,
    headers: { Allow: 'GET, HEAD', 'x-request-id': requestId },
  })
}
