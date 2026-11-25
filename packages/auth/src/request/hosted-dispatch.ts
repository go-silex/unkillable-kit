import { AppError, newRequestId } from '@kit/core'
import type { Env, ExecutionContext, Hono } from 'hono'
import { tryDecodeURIComponent } from 'hono/utils/url'
import type { HostedAdmission } from '../snapshot'
import { isIdentifier, unavailable } from '../snapshot/core-rows'
import { isHostedPrincipal } from '../snapshot/hosted-principal'
import { hostedClaims, hostedRoutes, inspectHostedRoutes, type Routes } from './hosted-routes'
import { organizationHeader } from './organization-selection'
import type { RequestAuthorization } from './request-authorization'

export type HostedDispatchOperation = Readonly<{
  method: string
  path: string
  organizationId?: string
  body?: unknown
  /** A repeated key carries each value in order. */
  query?: Readonly<Record<string, string | readonly string[]>>
  /** Only names the App declared for every matched handler of this operation. */
  headers?: Readonly<Record<string, string>>
}>

export type HostedDispatch = Readonly<{
  fetch(op: HostedDispatchOperation): Promise<Response>
  close(): void
}>

export type HostedDispatchOptions<E extends Env> = Readonly<{
  admission: Extract<HostedAdmission, { status: 'allowed' }>
  authorization: RequestAuthorization<E>
  app: Pick<Hono<E>, 'router' | 'getPath' | 'fetch'>
  env?: E['Bindings']
  executionCtx?: ExecutionContext
  outer: Request
  limit?: number
}>

function refusal(error: AppError) {
  return Response.json(
    { error: { code: error.code, message: error.message }, requestId: newRequestId() },
    { status: error.status, headers: { 'cache-control': 'no-store' } },
  )
}

function designationHeaders(outer: Request, organizationId: string | undefined) {
  const headers = new Headers()
  if (organizationId === undefined) return headers
  const invalid = 'Invalid organization designation'
  if (!isIdentifier(organizationId) || organizationId.includes(','))
    throw AppError.validation(invalid)
  let outerOrg: string | undefined
  try {
    outerOrg = organizationHeader(outer.headers)
    headers.set('X-Org-Id', organizationId)
  } catch {
    throw AppError.validation(invalid)
  }
  if (headers.get('X-Org-Id') !== organizationId) throw AppError.validation(invalid)
  if (outerOrg !== undefined && outerOrg !== organizationId)
    throw AppError.forbidden('Organization mismatch')
  return headers
}

/** Lowercase name → exact value; a value Fetch would rewrite or a repeated name is refused. */
function productHeaders(input: unknown): ReadonlyMap<string, string> {
  const headers = new Map<string, string>()
  if (input === undefined) return headers
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw AppError.validation('Invalid hosted operation')
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase()
    const probe = new Headers()
    try {
      if (typeof value !== 'string' || headers.has(lower)) throw new TypeError()
      probe.set(name, value)
    } catch {
      throw AppError.validation('Invalid hosted operation')
    }
    if (probe.get(name) !== value) throw AppError.validation('Invalid hosted operation')
    headers.set(lower, value)
  }
  return headers
}

/** Each value of a repeated key, in order; anything but a string or an array of strings throws. */
function queryPairs(query: unknown): [string, string][] {
  if (query === undefined) return []
  if (typeof query !== 'object' || query === null || Array.isArray(query)) throw new TypeError()
  return Object.entries(query).flatMap(([key, value]) => {
    const values: unknown = typeof value === 'string' ? [value] : value
    if (!Array.isArray(values) || values.some((item) => typeof item !== 'string'))
      throw new TypeError()
    return values.map((item: string): [string, string] => [key, item])
  })
}

function syntheticRequest(
  origin: string,
  { path, method, body, query }: HostedDispatchOperation,
  designation: Headers,
  extra: ReadonlyMap<string, string>,
) {
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/u.test(path)) {
    throw AppError.forbidden('Hosted operation not declared')
  }
  try {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw AppError.forbidden()
    for (const [key, value] of queryPairs(query)) url.searchParams.append(key, value)
    // Kit-owned fields are set last; preflight refuses any name the App did not declare.
    const headers = new Headers([...extra])
    for (const [name, value] of designation) headers.set(name, value)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    return new Request(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw AppError.validation('Invalid hosted operation')
  }
}

function preflight<E extends Env>(
  options: HostedDispatchOptions<E>,
  request: Request,
  policy: Routes | undefined,
  organizationId: string | undefined,
  extra: ReadonlyMap<string, string>,
) {
  if (!policy) throw AppError.forbidden('Hosted operation not declared')
  let matched: ReturnType<Hono<E>['router']['match']>
  try {
    const path = options.app.getPath(request, { env: options.env })
    matched = options.app.router.match(request.method === 'HEAD' ? 'GET' : request.method, path)
  } catch {
    throw unavailable()
  }
  const [matches, params] = matched
  const declaration = inspectHostedRoutes(
    matches.map(([[, route]]) => route),
    policy,
    options.app,
    organizationId !== undefined,
  )
  if (!declaration) throw AppError.forbidden('Hosted operation not declared')
  if ([...extra.keys()].some((name) => !declaration.headers.has(name)))
    throw AppError.forbidden('Hosted header not declared')
  if (organizationId !== undefined) {
    for (const [, indexes] of matches) {
      const param = params ? params[indexes.orgId as number] : indexes.orgId
      if (typeof param === 'string' && tryDecodeURIComponent(param) !== organizationId) {
        throw AppError.forbidden('Organization mismatch')
      }
    }
  }
  return { policy, platformRole: declaration.platformRole, headers: [...extra.keys()] }
}

/**
 * In-process dispatch only. The capability dies when the serving shell closes it.
 * @internal — composed only by @kit/mcp/hosted.
 */
export function createHostedDispatch<E extends Env>(
  options: HostedDispatchOptions<E>,
): HostedDispatch {
  const { app, env, executionCtx, outer, admission, authorization, limit = 8 } = options
  const policy = hostedRoutes.get(authorization)
  const lifetime = { open: true }
  let used = 0
  const origin = new URL(outer.url).origin
  if (!Number.isInteger(limit) || limit < 1 || limit > 8)
    throw new RangeError('Invalid dispatch limit')
  return Object.freeze({
    async fetch(op: HostedDispatchOperation): Promise<Response> {
      try {
        if (
          !lifetime.open ||
          admission.status !== 'allowed' ||
          !isHostedPrincipal(admission.principal)
        ) {
          throw AppError.unauthorized()
        }
        const { organizationId } = op
        const headers = designationHeaders(outer, organizationId)
        // Take the slot synchronously, before any await, even if routing or admission subsequently refuses.
        if (used >= limit) throw AppError.rateLimited('Hosted dispatch limit exceeded')
        used++
        const extra = productHeaders(op.headers)
        const request = syntheticRequest(origin, op, headers, extra)
        const declaration = preflight(options, request, policy, organizationId, extra)
        hostedClaims.set(request, {
          ...declaration,
          app,
          lifetime,
          principal: admission.principal,
          organizationId,
          claimed: false,
        })
        try {
          return await app.fetch(request, env, executionCtx)
        } catch {
          throw unavailable()
        }
      } catch (error) {
        return refusal(error instanceof AppError ? error : unavailable())
      }
    },
    close() {
      lifetime.open = false
    },
  })
}
