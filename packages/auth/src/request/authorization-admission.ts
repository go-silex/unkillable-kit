import { AppError } from '@kit/core'
import type { Context, Env } from 'hono'
import type { BetterAuthLike } from '../better-auth-port'
import { accessAllows, isModuleAccess } from '../module-grants'
import type { PlatformRole } from '../org-roles'
import type { ApiKeyScope, AuthIdentity } from '../require-auth'
import type { SessionCookieInput } from '../snapshot/cookie'
import type { AuthorizationFact } from '../snapshot/facts'
import type { RequestSnapshot } from '../snapshot/load'
import {
  type AuthorizationPlan,
  authUnavailable,
  type ModuleAuthorizationFacts,
  selectedOrganization,
} from './authorization-plan'
import { requestSessionCookie } from './effective-session-cookie'

export type OrgContextOpts = Readonly<{
  allowSuperAdmin?: boolean
  allowSuperAdminWrite?: boolean
}>

type OrgMiddlewareEnv = {
  Variables: {
    subject?: string
    sessionId?: string
    authMethod?: 'session' | 'api_key'
    keyOrganizationId?: string
    keyScopes?: ApiKeyScope[]
    requestId?: string
    orgId?: string
    orgRole?: string
    orgBypass?: boolean
    platformRole?: PlatformRole | null
  }
}

/** Shared HTTP and Capability Grant minting backstop denial wording. */
export const MODULE_DENIAL = {
  notAvailable: 'Module not available',
  insufficientGrant: 'Insufficient module grant',
} as const

export type GuardState<E extends Env> = {
  plan: AuthorizationPlan<E>
  load: Promise<RequestSnapshot>
  authority?: { secret?: string; fingerprint?: string }
  factsAdmitted: boolean
  authenticated: boolean
  keyScope: boolean
  fence: boolean
  delegated: 'recovery' | 'business' | null
  org: Readonly<{ role: string | null; bypass: boolean }> | undefined
}

export function resolveRequestSessionCookie<E extends Env>(
  c: Context<E>,
  options: Readonly<{ auth: (c: Context<E>) => BetterAuthLike | undefined }>,
  allowCookie: boolean,
  authority: GuardState<E>['authority'],
): SessionCookieInput | undefined {
  if (!allowCookie) return
  const header = c.req.header('cookie')
  if (!header) return
  try {
    const auth = options.auth(c)
    if (!auth) return
    const cookie = requestSessionCookie(auth, header)
    if (authority) authority.secret = cookie.secret
    return cookie
  } catch (error) {
    if (authority) throw authUnavailable()
    throw error
  }
}

export function contextVariables<E extends Env>(c: Context<E>) {
  return c as unknown as Context<OrgMiddlewareEnv>
}

export function projectIdentity<E extends Env>(c: Context<E>, identity: AuthIdentity) {
  const out = contextVariables(c)
  out.set('subject', identity.subject)
  out.set('authMethod', identity.method)
  if (identity.method === 'api_key') {
    out.set('keyOrganizationId', identity.organizationId)
    out.set('keyScopes', [...identity.scopes])
  } else {
    out.set('sessionId', identity.sessionId)
  }
}

export function snapshotFacts<E extends Env>(
  plan: AuthorizationPlan<E>,
): AuthorizationFact<unknown>[] {
  const facts = new Set(plan.facts)
  if (plan.authority) facts.add(plan.authority.projection)
  for (const policy of plan.modules.values()) {
    if (
      policy.availability.scope.kind !== 'organization' ||
      policy.grant.scope.kind !== 'organization-role' ||
      (policy.delegatedGrant && policy.delegatedGrant.scope.kind !== 'delegated-role')
    ) {
      throw authUnavailable()
    }
    facts.add(policy.availability)
    facts.add(policy.grant)
    if (policy.delegatedGrant) facts.add(policy.delegatedGrant)
  }
  return [...facts]
}

export function isOrgFact(kind: AuthorizationFact<unknown>['scope']['kind']) {
  return (
    kind === 'organization' ||
    kind === 'organization-role' ||
    kind === 'delegated-role' ||
    kind === 'delegated-user'
  )
}

function organizationBypass(
  method: string,
  role: string | null,
  platformRole: PlatformRole | null,
  opts: OrgContextOpts,
) {
  if (role !== null) return false
  if (platformRole !== 'super_admin') throw AppError.notFound('Organization not found')
  const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  if ((safe && opts.allowSuperAdmin) || (!safe && opts.allowSuperAdminWrite)) return true
  if (!safe && opts.allowSuperAdmin)
    throw AppError.forbidden('Super admin write requires break-glass flag')
  throw AppError.notFound('Organization not found')
}

function policyFlag(value: unknown) {
  if (value === 0) return false
  if (value === 1) return true
  throw authUnavailable()
}

export function assertModule(
  policy: ModuleAuthorizationFacts | undefined,
  snapshot: RequestSnapshot,
  mode: 'normal' | 'bypass' | 'delegated',
  op: 'read' | 'write',
) {
  if (!policy) throw AppError.notFound(MODULE_DENIAL.notAvailable)
  const [availability, extra] = snapshot.rows(policy.availability)
  if (extra) throw authUnavailable()
  const enabled = availability ? policyFlag(availability.enabled) : false
  const available = availability ? policyFlag(availability.available) : false
  if (!(enabled && available)) {
    throw AppError.notFound(MODULE_DENIAL.notAvailable)
  }
  if (mode === 'bypass') return
  const fact = mode === 'delegated' ? policy.delegatedGrant : policy.grant
  const [grant, extraGrant] = fact ? snapshot.rows(fact) : []
  if (extraGrant) throw authUnavailable()
  if (!grant) throw AppError.forbidden(MODULE_DENIAL.insufficientGrant)
  const { access } = grant
  if (typeof access !== 'string' || !isModuleAccess(access)) throw authUnavailable()
  if (!accessAllows(access, op)) {
    throw AppError.forbidden(MODULE_DENIAL.insufficientGrant)
  }
  return access
}

export function directIdentity(snapshot: RequestSnapshot, keyScope: boolean) {
  const { identity } = snapshot
  if (!identity || identity.method === 'mcp') throw AppError.unauthorized()
  if (identity.method === 'api_key' && !keyScope) throw AppError.forbidden()
  return identity
}

function organizationFor<E extends Env>(
  state: GuardState<E>,
  snapshot: RequestSnapshot,
  orgId: string,
) {
  const { identity } = snapshot
  if (identity?.method === 'api_key' && identity.organizationId !== orgId) {
    throw AppError.forbidden('API key is bound to a different organization')
  }
  const delegation = state.delegated ? snapshot.delegation : undefined
  if (delegation && orgId !== delegation.row?.organizationId) {
    throw AppError.forbidden('Organization mismatch')
  }
  const org = delegation ? delegation.organization : snapshot.organization
  if (!org) throw AppError.notFound('Organization not found')
  return org
}

function auditOrganizationBypass(
  method: string,
  orgId: string,
  actor: string | undefined,
  requestId: string | undefined,
) {
  console.info(
    JSON.stringify({
      level: 'info',
      msg: 'super_admin_org_bypass',
      action: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write',
      actor,
      orgId,
      requestId,
    }),
  )
}

function isAdmittedFactScope<E extends Env>(
  state: GuardState<E>,
  kind: AuthorizationFact<unknown>['scope']['kind'],
) {
  if (kind === 'hosted-grant' || state.delegated === 'recovery') return false
  if (isOrgFact(kind) && !state.org) return false
  if (kind === 'delegated-user' || kind === 'delegated-role') return state.delegated === 'business'
  if (kind === 'user' || kind === 'organization-role') return state.delegated === null
  return true
}

export function validateAdmittedFacts<E extends Env>(
  state: GuardState<E>,
  snapshot: RequestSnapshot,
) {
  if (!(state.authenticated && state.fence) || state.plan.pending.size) return
  if (snapshot.identity?.method === 'api_key' && !state.keyScope) return
  for (const descriptor of state.plan.facts) {
    if (isAdmittedFactScope(state, descriptor.scope.kind)) snapshot.rows(descriptor)
  }
  state.factsAdmitted = true
}

export function admitOrganization<E extends Env>(
  c: Context<E>,
  state: GuardState<E>,
  snapshot: RequestSnapshot,
  bypassPolicy: OrgContextOpts,
) {
  if (!state.authenticated) throw AppError.unauthorized()
  if (state.delegated === 'recovery') throw AppError.forbidden()
  const orgId = selectedOrganization(state.plan)
  const org = organizationFor(state, snapshot, orgId)
  const bypass = organizationBypass(
    c.req.method,
    org.membershipRole,
    org.platformRole,
    bypassPolicy,
  )
  if (org.status !== 'active') throw AppError.forbidden('Organization is not active')
  state.org = { role: org.membershipRole, bypass }
  const out = contextVariables(c)
  out.set('orgId', orgId)
  out.set('orgRole', org.membershipRole ?? undefined)
  out.set('orgBypass', bypass)
  out.set('platformRole', org.platformRole)
  if (bypass) {
    auditOrganizationBypass(c.req.method, orgId, snapshot.identity?.subject, out.get('requestId'))
  }
}

export async function readAdmittedFact<T, E extends Env>(
  state: GuardState<E> | undefined,
  descriptor: AuthorizationFact<T>,
): Promise<T> {
  if (
    !(
      state?.factsAdmitted &&
      state.plan.facts.has(descriptor) &&
      isAdmittedFactScope(state, descriptor.scope.kind)
    )
  ) {
    throw AppError.forbidden('Authorization fact is not admitted for this scope')
  }
  const snapshot = await state.load
  try {
    return descriptor.decode(snapshot.rows(descriptor))
  } catch {
    throw authUnavailable()
  }
}
