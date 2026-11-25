import { AppError, newRequestId } from '@kit/core'
import type { Env, ExecutionContext, Hono } from 'hono'
import { tryDecodeURIComponent } from 'hono/utils/url'
import {
  hostedClaims,
  hostedRoutes,
  inspectHostedRoutes,
  type Routes,
} from './request/hosted-routes'
import { organizationHeader } from './request/organization-selection'
import type { RequestAuthorization } from './request/request-authorization'
import type { HostedAdmission } from './snapshot'
import { isIdentifier, unavailable } from './snapshot/core-rows'
import { isHostedPrincipal } from './snapshot/hosted-principal'

export type HostedDispatchOperation = Readonly<{
  method: string
  path: string
  organizationId?: string
  body?: unknown
  query?: Record<string, string>
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

function syntheticRequest(
  origin: string,
  { path, method, body, query }: HostedDispatchOperation,
  headers: Headers,
) {
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/u.test(path)) {
    throw AppError.forbidden('Hosted operation not declared')
  }
  try {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw AppError.forbidden()
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
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
  if (organizationId !== undefined) {
    for (const [, indexes] of matches) {
      const param = params ? params[indexes.orgId as number] : indexes.orgId
      if (typeof param === 'string' && tryDecodeURIComponent(param) !== organizationId) {
        throw AppError.forbidden('Organization mismatch')
      }
    }
  }
  return { policy, platformRole: declaration.platformRole }
}

/** In-process dispatch only. The capability dies when the serving shell closes it. */
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
        const request = syntheticRequest(origin, op, headers)
        const declaration = preflight(options, request, policy, organizationId)
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
