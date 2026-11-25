import { AppError } from '@kit/core'
import type { Context, Env } from 'hono'
import type { RouterRoute } from 'hono/types'
import { accessAllows, type ModuleOp } from '../module-grants'
import type { PlatformRole } from '../org-roles'
import type { ImpersonationSession } from '../repos/impersonation'
import type { ApiKeyScope } from '../require-auth'
import type { CoreSnapshot } from '../snapshot/core-load'
import { isIdentifier, type Modules, type Organization, unavailable } from '../snapshot/core-rows'
import type { Route } from './hosted-routes'

export type ImpersonationOperation =
  | Readonly<{ kind: 'recovery' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'business'; modules: readonly string[]; op: ModuleOp }>

export type ImpersonationPolicy<E extends Env> = Readonly<{
  operation(
    request: Readonly<{ method: string; path: string; routes: readonly Route[] }>,
  ): ImpersonationOperation | null
  fence(c: Context<E>): string | undefined
  audit(
    c: Context<E>,
    attempt: Readonly<{ row: Readonly<ImpersonationSession>; method: string; path: string }>,
  ): Promise<void>
}>

export type OrgContextOpts<E extends Env = Env> = Readonly<{
  allowSuperAdmin?: boolean
  allowSuperAdminWrite?: boolean
  organizationId?: (c: Context<E>) => string
}>

export type KeyScopePolicy = (route: Route, scopes: readonly ApiKeyScope[]) => boolean

export const MODULE_DENIAL = {
  notAvailable: 'Module not available',
  insufficientGrant: 'Insufficient module grant',
} as const

export const NEED_ORG = 'organization id required (path or X-Org-Id)'

export function admitKeyScope(
  policy: KeyScopePolicy | undefined,
  routes: readonly RouterRoute[],
  scopes: readonly ApiKeyScope[],
) {
  if (!(policy && routes.length)) throw AppError.forbidden()
  let admitted = true
  try {
    for (const { method, path } of routes) {
      const decision = policy(Object.freeze({ method, path }), scopes)
      if (decision === false) admitted = false
      else if (decision !== true) throw unavailable()
    }
  } catch {
    throw unavailable()
  }
  if (!admitted) throw AppError.forbidden()
}

type ImpersonationAdmission<E extends Env> = {
  c: Context<E>
  policy: ImpersonationPolicy<E>
  snapshot: CoreSnapshot
  routes: readonly RouterRoute[]
  selection: string | undefined
  selectionError: AppError | undefined
  hasBearerScheme: boolean
  hasParsedBearer: boolean
  signOut: boolean
  nativeMount: boolean
}

function isOperation(value: ImpersonationOperation | null): boolean {
  if (value === null || value?.kind === 'recovery' || value?.kind === 'conflict') return true
  return (
    value?.kind === 'business' &&
    (value.op === 'read' || value.op === 'write') &&
    Array.isArray(value.modules) &&
    value.modules.every(isIdentifier)
  )
}

function classify<E extends Env>(input: ImpersonationAdmission<E>, method: string, path: string) {
  const { c, policy, routes, snapshot } = input
  try {
    const fence = policy.fence(c)
    if (fence !== undefined && typeof fence !== 'string') throw unavailable()
    if (!snapshot.delegation && (fence === undefined || fence === 'none'))
      return { fence, operation: null }
    const operation = policy.operation(
      Object.freeze({
        method,
        path,
        routes: Object.freeze(routes.map(({ method, path }) => Object.freeze({ method, path }))),
      }),
    )
    if (!isOperation(operation)) throw unavailable()
    return { fence, operation }
  } catch {
    throw unavailable()
  }
}

function assertAttachedIdentity(
  delegation: NonNullable<CoreSnapshot['delegation']>,
  hasBearerScheme: boolean,
) {
  if (hasBearerScheme)
    throw AppError.forbidden('Bearer credentials cannot be combined with impersonation')
  if (delegation.row.actorUserId !== delegation.actor.subject || !delegation.targetActive) {
    throw AppError.unauthorized()
  }
}

function assertDelegatedModules(
  modules: Modules,
  { modules: ids, op }: Extract<ImpersonationOperation, { kind: 'business' }>,
  selection: string | undefined,
) {
  if (ids.length && selection === undefined) throw AppError.validation(NEED_ORG)
  for (const moduleId of ids) {
    const module = modules === 'disabled' ? undefined : modules.get(moduleId)
    if (!(module?.available && accessAllows(module.access, op)))
      throw AppError.forbidden('Module access required')
  }
}
function assertBusiness<E extends Env>(
  input: ImpersonationAdmission<E>,
  operation: ImpersonationOperation | null,
  fence: string | undefined,
  delegation: NonNullable<CoreSnapshot['delegation']>,
) {
  const { row, eligible } = delegation
  const { selection, selectionError, snapshot, nativeMount } = input
  if (fence !== row.id) throw AppError.conflict('Impersonation context changed')
  if (operation?.kind === 'conflict') throw AppError.conflict('Impersonation already active')
  if (!eligible) throw AppError.forbidden('Impersonation is no longer eligible')
  if (
    nativeMount ||
    operation?.kind !== 'business' ||
    (row.mode === 'read' && operation.op === 'write')
  ) {
    throw AppError.forbidden('Operation unavailable during impersonation')
  }
  if (selectionError) throw selectionError
  if (selection !== undefined && selection !== row.organizationId)
    throw AppError.forbidden('Organization mismatch')
  assertDelegatedModules(snapshot.modules, operation, selection)
}

export async function admitImpersonation<E extends Env>(input: ImpersonationAdmission<E>) {
  const { c, policy, snapshot, hasBearerScheme, hasParsedBearer, signOut } = input
  const delegation = snapshot.delegation
  if (delegation) assertAttachedIdentity(delegation, hasBearerScheme)
  const { method } = c.req
  const path = new URL(c.req.url).pathname
  const { fence, operation } = classify(input, method, path)
  if (!delegation) {
    if (
      fence !== undefined &&
      fence !== 'none' &&
      (operation?.kind !== 'recovery' || hasParsedBearer || signOut || input.nativeMount)
    ) {
      throw AppError.conflict('Impersonation context changed')
    }
    return
  }
  // Existing recovery endpoints let the actor inspect/stop a changed context and sign out.
  if (operation?.kind === 'recovery') {
    if (input.nativeMount && !signOut)
      throw AppError.forbidden('Operation unavailable during impersonation')
    return 'recovery' as const
  }
  assertBusiness(input, operation, fence, delegation)
  try {
    await policy.audit(c, Object.freeze({ row: delegation.row, method, path }))
  } catch {
    throw unavailable()
  }
  return 'business' as const
}

export type AdmittedOrganization = Organization & Readonly<{ bypass: boolean; modules: Modules }>

type OrganizationAdmission = {
  id: string | undefined
  snapshot: CoreSnapshot
  method: string
  allowSuperAdmin?: boolean
  allowSuperAdminWrite?: boolean
  platformRole: PlatformRole | null
}

function breakGlass({
  method,
  platformRole,
  allowSuperAdmin,
  allowSuperAdminWrite,
}: OrganizationAdmission) {
  if (platformRole !== 'super_admin') throw AppError.notFound('Organization not found')
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    if (allowSuperAdmin) return true
  } else {
    if (allowSuperAdminWrite) return true
    if (allowSuperAdmin) throw AppError.forbidden('Super admin write requires break-glass flag')
  }
  throw AppError.notFound('Organization not found')
}

export function admitOrganization(input: OrganizationAdmission): AdmittedOrganization {
  const { id, snapshot } = input
  if (id === undefined) throw AppError.validation(NEED_ORG)
  const organization = snapshot.organization
  if (!organization || organization.id !== id) throw AppError.notFound('Organization not found')
  const bypass = organization.role === null && breakGlass(input)
  if (organization.status !== 'active') throw AppError.forbidden('Organization is not active')
  return Object.freeze({ ...organization, bypass, modules: snapshot.modules })
}
