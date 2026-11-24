import { AppError } from '@kit/core'
import type { KitD1Database } from '@kit/db'
import type { BetterAuthLike } from './better-auth-port'
import type { OrgContextRecord } from './org-roles'
import { requestSessionCookie } from './request/effective-session-cookie'
import type { AuthorizationFact } from './snapshot/facts'
import { loadRequestSnapshot, type RequestSnapshot } from './snapshot/load'

export {
  type AuthorizationFact,
  type AuthorizationRow,
  defineAuthorizationFact,
} from './snapshot/facts'

/** Probe the actual issuer's read-only session path without a refresh or cookie write. */
export async function resolveRequestSession(input: {
  db: KitD1Database
  headers: Headers
  auth: BetterAuthLike
}) {
  const { identity } = await loadRequestSnapshot({
    db: input.db,
    cookie: requestSessionCookie(input.auth, input.headers.get('cookie')),
  })
  return identity?.method === 'session' ? identity : null
}

type ReadFact = <T>(descriptor: AuthorizationFact<T>) => T
export type HostedAuthorization = Readonly<{
  fact: ReadFact
  forOrganization: (id: string) => HostedOrganization | null
}>

type HostedOrganization = Readonly<{ organization: Readonly<OrgContextRecord>; fact: ReadFact }>

type HostedAdmission =
  | { status: 'denied' | 'unavailable' }
  | Readonly<
      HostedAuthorization & { status: 'allowed'; organization: Readonly<OrgContextRecord> | null }
    >

function hostedOrgScope(kind: AuthorizationFact<unknown>['scope']['kind']) {
  return kind === 'organization' || kind === 'organization-role'
}

/** OAuth callers must pass provider-verified IDs. External admission never receives D1 rows. */
export async function authorizeHostedPrincipal(input: {
  db: KitD1Database
  principal: { userId: string; grantId?: string; clientId?: string }
  organizationId?: string
  facts?: readonly AuthorizationFact<unknown>[]
  denyFact?: AuthorizationFact<unknown>
  admit?: () => Promise<boolean>
}): Promise<HostedAdmission> {
  try {
    if (input.denyFact && input.denyFact.scope.kind !== 'hosted-grant') {
      return { status: 'unavailable' }
    }
    const scopeId = input.organizationId?.trim()
    const facts = (input.facts ?? []).filter(
      (fact) =>
        fact !== input.denyFact &&
        (fact.scope.kind === 'user' ||
          fact.scope.kind === 'hosted-grant' ||
          (scopeId && hostedOrgScope(fact.scope.kind))),
    )
    const snapshot = await loadRequestSnapshot({
      db: input.db,
      hosted: input.principal,
      organizationId: scopeId,
      facts: input.denyFact ? [...facts, input.denyFact] : facts,
    })
    if (snapshot.identity?.method !== 'mcp') return { status: 'denied' }
    if (input.denyFact && snapshot.rows(input.denyFact).length !== 0) return { status: 'denied' }
    if (input.admit) {
      const policy = await input.admit()
      if (policy === false) return { status: 'denied' }
      if (policy !== true) return { status: 'unavailable' }
    }
    return hostedAdmission(scopeId, facts, snapshot)
  } catch {
    return { status: 'unavailable' }
  }
}

function hostedAdmission(
  scopeId: string | undefined,
  facts: readonly AuthorizationFact<unknown>[],
  snapshot: RequestSnapshot,
): HostedAdmission {
  const org = snapshot.organization
  const organization =
    scopeId && org?.status === 'active' && org.membershipRole ? Object.freeze(org) : null
  // Validate siblings for the admitted scope before executing any Product decoder.
  for (const descriptor of facts) {
    if (!hostedOrgScope(descriptor.scope.kind)) snapshot.rows(descriptor)
  }
  function organizationAccess(id: string): HostedOrganization | null {
    if (scopeId !== id || !organization) return null
    for (const descriptor of facts) {
      if (hostedOrgScope(descriptor.scope.kind)) snapshot.rows(descriptor)
    }
    return { organization, fact: (descriptor) => read(descriptor, true) }
  }
  function read<T>(descriptor: AuthorizationFact<T>, scoped: boolean): T {
    if (!facts.includes(descriptor) || hostedOrgScope(descriptor.scope.kind) !== scoped) {
      throw AppError.forbidden('Authorization fact is not admitted for this scope')
    }
    try {
      return descriptor.decode(snapshot.rows(descriptor))
    } catch {
      throw new AppError('INTERNAL_ERROR', 'Authorization unavailable', 503)
    }
  }
  return {
    status: 'allowed',
    organization,
    fact: (descriptor) => read(descriptor, false),
    forOrganization: organizationAccess,
  }
}
