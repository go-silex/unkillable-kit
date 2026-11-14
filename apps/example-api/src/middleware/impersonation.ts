import { createBetterAuthSessionPort } from '@kit/auth'
import type { ImpersonationSession } from '@kit/auth/repos/impersonation'
import { findImpersonationSession, recordImpersonationRequest } from '@kit/auth/repos/impersonation'
import * as orgsRepo from '@kit/auth/repos/orgs'
import { COMMENTS_MODULE_ID } from '@kit/comments'
import { AppError } from '@kit/core'
import { TASKS_MODULE_ID } from '@kit/tasks'
import type { Context, MiddlewareHandler, Next } from 'hono'
import { sessionCookieNameFromEnv } from '../lib/session-env'
import { getImpersonationEligibility, getImpersonationInfo } from '../services/impersonation'
import { resolveModuleAccess } from '../services/org-roles'
import type { AppEnv } from '../types'

// Explicit route/method inventory: personal, identity and durable workflow APIs are excluded.
function businessOperation(
  method: string,
  path: string,
): { modules: string[]; op: 'read' | 'write' } | null {
  if (method === 'GET' && (path === '/api/modules' || /^\/api\/orgs\/[^/]+\/modules$/.test(path)))
    return { modules: [], op: 'read' }
  const op = method === 'GET' ? 'read' : 'write'
  const basic =
    (path === '/api/tasks' && ['GET', 'POST'].includes(method)) ||
    (path === '/api/tasks/stages' && method === 'GET') ||
    (path === '/api/tasks/links' && ['GET', 'POST'].includes(method)) ||
    (/^\/api\/tasks\/[^/]+$/.test(path) && ['GET', 'PATCH', 'DELETE'].includes(method))
  const comments =
    (/^\/api\/tasks\/[^/]+\/comments$/.test(path) && ['GET', 'POST'].includes(method)) ||
    (/^\/api\/tasks\/comments\/[^/]+$/.test(path) && method === 'DELETE')
  if (comments) return { modules: [TASKS_MODULE_ID, COMMENTS_MODULE_ID], op }
  if (basic) return { modules: [TASKS_MODULE_ID], op }
  return null
}

async function admitBusiness(c: Context<AppEnv>, row: ImpersonationSession, path: string) {
  const db = c.get('db')!
  const operation = businessOperation(c.req.method, path)
  if (!operation || (row.mode === 'read' && operation.op === 'write'))
    throw AppError.forbidden('Operation unavailable during impersonation')
  const headerOrg = c.req.header('x-org-id')?.trim()
  const pathOrg = /^\/api\/orgs\/([^/]+)/.exec(path)?.[1]
  if (
    (headerOrg && headerOrg !== row.organizationId) ||
    (pathOrg && decodeURIComponent(pathOrg) !== row.organizationId)
  )
    throw AppError.forbidden('Organization mismatch')
  const membership = await orgsRepo.findMembership(db, row.organizationId, row.subjectUserId)
  if (!membership) throw AppError.forbidden('Membership required')
  for (const moduleId of operation.modules) {
    if (
      !(await resolveModuleAccess(db, {
        organizationId: row.organizationId,
        roleKey: membership.role,
        moduleId,
        op: operation.op,
        readOnly: true,
      }))
    )
      throw AppError.forbidden('Module access required')
  }
  await recordImpersonationRequest(db, row, {
    requestId: c.get('requestId'),
    method: c.req.method,
    path,
    ip: c.req.header('cf-connecting-ip'),
  })
}

async function handleDelegation(
  c: Context<AppEnv>,
  next: Next,
  row: ImpersonationSession,
  actor: string,
) {
  const db = c.get('db')!
  const path = new URL(c.req.url).pathname
  const fence = c.req.header('x-impersonation-id')
  const introspect = path === '/api/me' && c.req.method === 'GET'
  const start = path === '/api/impersonation/start' && c.req.method === 'POST'
  const stop = path === '/api/impersonation/stop' && c.req.method === 'POST'
  if (/^\s*Bearer\b/i.test(c.req.header('authorization') ?? ''))
    throw AppError.forbidden('Bearer credentials cannot be combined with impersonation')
  if (row.actorUserId !== actor) throw AppError.unauthorized()
  c.set('actorSubject', actor)
  c.set('sessionId', row.sessionId)
  c.set('impersonationRow', row)
  c.set('subject', row.subjectUserId)
  c.set('authMethod', 'session')
  if (stop || (path === '/api/auth/sign-out' && c.req.method === 'POST')) {
    await next()
    return
  }
  const eligible = await getImpersonationEligibility(db, row)
  const info = await getImpersonationInfo(db, row, eligible)
  c.set('impersonationInfo', info)
  if (introspect) {
    await next()
    return
  }
  if (fence !== row.id) throw AppError.conflict('Impersonation context changed')
  if (start) throw AppError.conflict('Impersonation already active')
  if (!info.active) throw AppError.forbidden('Impersonation is no longer eligible')
  await admitBusiness(c, row, path)
  await next()
}

function assertUnattachedFence(c: Context<AppEnv>) {
  const path = new URL(c.req.url).pathname
  const introspect = path === '/api/me' && c.req.method === 'GET'
  const stop = path === '/api/impersonation/stop' && c.req.method === 'POST'
  const fence = c.req.header('x-impersonation-id')
  if (!(introspect || stop) && fence !== undefined && fence !== 'none')
    throw AppError.conflict('Impersonation context changed')
}

export const impersonationGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('betterAuth')
  const db = c.get('db')
  if (!(auth && db)) throw AppError.internal('Authentication dependencies missing')
  // Only the cookie is a session credential here, never an Authorization bearer.
  const headers = new Headers(c.req.raw.headers)
  headers.delete('authorization')
  const session = await createBetterAuthSessionPort({
    getAuth: () => auth,
    cookieName: sessionCookieNameFromEnv(c.env),
  }).resolveSession({ headers })
  if (!session) {
    assertUnattachedFence(c)
    await next()
    return
  }
  const row = await findImpersonationSession(db, session.sessionId)
  if (!row) {
    if (!/^\s*Bearer\b/i.test(c.req.header('authorization') ?? '')) {
      c.set('actorSubject', session.sub)
      c.set('sessionId', session.sessionId)
    }
    assertUnattachedFence(c)
    await next()
    return
  }
  await handleDelegation(c, next, row, session.sub)
}
