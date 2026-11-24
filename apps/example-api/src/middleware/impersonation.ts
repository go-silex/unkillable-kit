import { parseBearer } from '@kit/auth'
import {
  type ImpersonationSession,
  recordImpersonationRequest,
} from '@kit/auth/repos/impersonation'
import { COMMENTS_MODULE_ID } from '@kit/comments'
import { AppError } from '@kit/core'
import { TASKS_MODULE_ID } from '@kit/tasks'
import type { Context, MiddlewareHandler } from 'hono'
import { impersonationInfo } from '../services/impersonation'
import type { AppEnv } from '../types'
import { authorization } from './authorization'

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
  const operation = businessOperation(c.req.method, path)
  if (!operation || (row.mode === 'read' && operation.op === 'write'))
    throw AppError.forbidden('Operation unavailable during impersonation')
  const selection = authorization.organizationSelection(c)
  if (
    selection.kind === 'conflict' ||
    (selection.kind === 'selected' && selection.id !== row.organizationId)
  ) {
    throw AppError.forbidden('Organization mismatch')
  }
  if (operation.modules.length && selection.kind === 'missing') {
    throw AppError.validation('organization id required (path or X-Org-Id)')
  }
  for (const moduleId of operation.modules) {
    await authorization.assertDelegationModule(c, moduleId, operation.op)
  }
  const db = c.get('db')!
  await recordImpersonationRequest(db, row, {
    requestId: c.get('requestId'),
    method: c.req.method,
    path,
    ip: c.req.header('cf-connecting-ip'),
  })
  await authorization.admitDelegation(c, 'business')
}

function assertUnattachedFence(c: Context<AppEnv>, recovery: boolean) {
  const fence = c.req.header('x-impersonation-id')
  if (!recovery && fence !== undefined && fence !== 'none')
    throw AppError.conflict('Impersonation context changed')
}

async function admitAttachedBusiness(
  c: Context<AppEnv>,
  row: ImpersonationSession,
  path: string,
  eligible: boolean,
) {
  if (c.req.header('x-impersonation-id') !== row.id)
    throw AppError.conflict('Impersonation context changed')
  if (path === '/api/impersonation/start' && c.req.method === 'POST')
    throw AppError.conflict('Impersonation already active')
  if (!eligible) throw AppError.forbidden('Impersonation is no longer eligible')
  await admitBusiness(c, row, path)
}

function assertAttachedIdentity(hasBearer: boolean, actorMatches: boolean, targetActive: boolean) {
  if (hasBearer)
    throw AppError.forbidden('Bearer credentials cannot be combined with impersonation')
  if (!(actorMatches && targetActive)) throw AppError.unauthorized()
}

export const impersonationGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname
  const introspect = path === '/api/me' && c.req.method === 'GET'
  const stop = path === '/api/impersonation/stop' && c.req.method === 'POST'
  const credential = c.req.header('authorization')
  const hasBearer = /^\s*Bearer\b/i.test(credential ?? '')
  const delegation = await authorization.delegation(c)
  if (!delegation?.row) {
    // Recovery can clear a stale browser context, but must never change to a key identity.
    assertUnattachedFence(c, (introspect || stop) && !parseBearer(credential))
    if (delegation && !hasBearer) {
      c.set('actorSubject', delegation.actor.subject)
      c.set('sessionId', delegation.actor.sessionId)
    }
    authorization.admitFence(c)
    await next()
    return
  }

  const { actor, row } = delegation
  assertAttachedIdentity(hasBearer, row.actorUserId === actor.subject, delegation.targetActive)
  const signOut = path === '/api/auth/sign-out' && c.req.method === 'POST'
  if (introspect || stop || signOut) {
    await authorization.admitDelegation(c, 'recovery')
  } else {
    await admitAttachedBusiness(c, row, path, delegation.eligible)
  }
  c.set('actorSubject', actor.subject)
  c.set('impersonationRow', row)
  if (!(stop || signOut)) {
    c.set(
      'impersonationInfo',
      impersonationInfo(row, delegation.actorProfile, delegation.targetProfile),
    )
  }
  await next()
}
