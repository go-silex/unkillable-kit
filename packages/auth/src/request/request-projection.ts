import { AppError } from '@kit/core'
import type { Context, Env } from 'hono'
import type { PlatformRole } from '../org-roles'
import type { ApiKeyScope } from '../require-auth'
import type { HostedIdentity, ImpersonationPermissions, Profile } from '../snapshot/core-rows'
import type { AdmittedOrganization } from './request-policy'
import type { Stage } from './request-state'

type AdmittedIdentity =
  | Readonly<{ method: 'session'; subject: string; sessionId: string }>
  | Readonly<{
      method: 'api_key'
      subject: string
      organizationId: string
      scopes: readonly ApiKeyScope[]
    }>
  | HostedIdentity

export type AdmittedView = Readonly<{
  identity?: AdmittedIdentity
  delegation?: Readonly<{
    id: string
    organizationId: string
    mode: 'read' | 'write'
    startedAt: number
    actor: Readonly<{ subject: string; sessionId: string }>
    recovery: boolean
    actorProfile: Profile | null
    targetProfile: Profile | null
  }>
  impersonationPermissions?: ImpersonationPermissions
  platformRole?: PlatformRole | null
  organization?: AdmittedOrganization
}>

type Projection = {
  Variables: {
    subject?: string
    sessionId?: string
    authMethod?: 'session' | 'api_key' | 'mcp'
    keyOrganizationId?: string
    keyScopes?: ApiKeyScope[]
    requestId?: string
    orgId?: string
    orgRole?: string
    orgBypass?: boolean
    platformRole?: PlatformRole | null
  }
}

export const EMPTY_VIEW: AdmittedView = Object.freeze({})

function projectVariables<E extends Env>(
  c: Context<E>,
  identity: AdmittedIdentity,
  platformRole: PlatformRole | null | undefined,
  organization: AdmittedOrganization | undefined,
) {
  const out = c as unknown as Context<Projection>
  out.set('subject', identity.subject)
  out.set('authMethod', identity.method)
  out.set('platformRole', platformRole ?? null)
  if (identity.method === 'session') out.set('sessionId', identity.sessionId)
  if (identity.method === 'api_key') {
    out.set('keyOrganizationId', identity.organizationId)
    out.set('keyScopes', [...identity.scopes])
  }
  if (organization) {
    out.set('orgId', organization.id)
    out.set('orgRole', organization.role ?? undefined)
    out.set('orgBypass', organization.bypass)
  }
}

export function project<E extends Env>(
  c: Context<E>,
  stage: Stage,
  organization?: AdmittedOrganization,
) {
  const { state, snapshot, delegationMode, platformRole } = stage
  const delegation = delegationMode ? snapshot.delegation : null
  const identified = snapshot.identity
  if (!identified) throw AppError.unauthorized()
  const identity: AdmittedIdentity =
    identified.method === 'session'
      ? Object.freeze({
          method: 'session',
          subject: delegation?.row.subjectUserId ?? identified.subject,
          sessionId: identified.sessionId,
        })
      : identified
  const delegationView = delegation
    ? Object.freeze({
        id: delegation.row.id,
        organizationId: delegation.row.organizationId,
        mode: delegation.row.mode,
        startedAt: delegation.row.createdAt,
        actor: Object.freeze({
          subject: delegation.actor.subject,
          sessionId: delegation.actor.sessionId,
        }),
        recovery: delegationMode === 'recovery',
        actorProfile: delegation.actorProfile,
        targetProfile: delegation.targetProfile,
      })
    : undefined
  if (organization?.bypass && !state.view.organization?.bypass) {
    console.info(
      JSON.stringify({
        level: 'info',
        msg: 'super_admin_org_bypass',
        action: ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ? 'read' : 'write',
        actor: identity.subject,
        orgId: organization.id,
        requestId: (c as unknown as Context<Projection>).get('requestId'),
      }),
    )
  }
  projectVariables(c, identity, platformRole, organization)
  state.view = Object.freeze({
    ...state.view,
    identity,
    ...(delegationView ? { delegation: delegationView } : {}),
    ...(snapshot.impersonationPermissions
      ? { impersonationPermissions: snapshot.impersonationPermissions }
      : {}),
    ...(platformRole !== undefined ? { platformRole } : {}),
    ...(organization ? { organization } : {}),
  })
}
