import { AppError } from '@kit/core'
import { isPlatformRole, type OrgContextRecord, type PlatformRole } from '../org-roles'
import type { ImpersonationSession } from '../repos/impersonation'
import type { AuthIdentity, SessionAuthIdentity } from '../require-auth'
import type { AuthorizationFact, AuthorizationRow, CompiledFact } from './facts'
import { validProjectionRows } from './projection'

type Profile = Readonly<{ name: string; email: string }>
type SessionIdentity = Readonly<SessionAuthIdentity & { email: string }>

export type DelegationSnapshot = Readonly<{
  actor: SessionIdentity
  row: Readonly<ImpersonationSession> | null
  organization: Readonly<OrgContextRecord> | null
  actorMembershipRole: string | null
  actorPlatformRole: PlatformRole | null
  targetPlatformRole: PlatformRole | null
  targetActive: boolean
  permission: Readonly<{ read: boolean; write: boolean }>
  eligible: boolean
  actorProfile: Profile | null
  targetProfile: Profile | null
}>

type HostedIdentity = { method: 'mcp'; subject: string }
export type Identity =
  | Readonly<Exclude<AuthIdentity, SessionAuthIdentity> | HostedIdentity>
  | SessionIdentity

export function unavailable(): AppError {
  return new AppError('INTERNAL_ERROR', 'Authorization unavailable', 503)
}

function isRow(value: unknown): value is AuthorizationRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function requiredString(row: AuthorizationRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw unavailable()
  return value
}

function optionalString(row: AuthorizationRow, key: string): string | null {
  return row[key] === null ? null : requiredString(row, key)
}

export function role(row: AuthorizationRow, key: string): PlatformRole | null {
  const value = optionalString(row, key)
  return value && isPlatformRole(value) ? value : null
}

function bit(row: AuthorizationRow, key: string): boolean {
  const value = row[key]
  if (value !== null && value !== 0 && value !== 1) throw unavailable()
  return value === 1
}

export function organization(
  row: AuthorizationRow,
  membership: string,
  platformRole: PlatformRole | null,
): Readonly<OrgContextRecord> | null {
  const status = optionalString(row, 'organization_status')
  const membershipRole = optionalString(row, membership)
  return status === null ? null : Object.freeze({ status, membershipRole, platformRole })
}

export function sessionIdentity(
  subject: string,
  sessionId: string,
  email: unknown,
): SessionIdentity {
  if (!(subject.trim() && sessionId.trim())) throw unavailable()
  return Object.freeze({
    method: 'session',
    subject,
    sessionId,
    email: typeof email === 'string' ? email : '',
  })
}

export function expiry(row: AuthorizationRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw unavailable()
  return value
}

export function decodeDelegation(
  data: AuthorizationRow | null,
  now: number,
): DelegationSnapshot | null {
  if (!data || expiry(data, 'session_expiry') < now) return null
  const actor = sessionIdentity(
    requiredString(data, 'actor'),
    requiredString(data, 'session_id'),
    data.actor_email,
  )
  const id = optionalString(data, 'id')
  const actorPlatformRole = role(data, 'actor_platform_role')
  const permission = Object.freeze({
    read: bit(data, 'permit_read'),
    write: bit(data, 'permit_write'),
  })
  if (id === null) {
    return Object.freeze({
      actor,
      row: null,
      organization: null,
      actorMembershipRole: null,
      actorPlatformRole,
      targetPlatformRole: null,
      targetActive: false,
      permission,
      eligible: false,
      actorProfile: null,
      targetProfile: null,
    })
  }
  const mode = requiredString(data, 'mode')
  const createdAt = data.created_at
  if (
    !(
      (mode === 'read' || mode === 'write') &&
      typeof createdAt === 'number' &&
      Number.isSafeInteger(createdAt)
    )
  )
    throw unavailable()
  const row = Object.freeze({
    id,
    sessionId: actor.sessionId,
    actorUserId: requiredString(data, 'actor_user_id'),
    subjectUserId: requiredString(data, 'target_id'),
    organizationId: requiredString(data, 'organization_id'),
    mode,
    createdAt,
  })
  const org = organization(data, 'target_membership_role', null)
  const actorMembershipRole = optionalString(data, 'actor_membership_role')
  const targetPlatformRole = role(data, 'target_platform_role')
  const targetActive = data.target_disabled !== null && !bit(data, 'target_disabled')
  const eligible =
    row.actorUserId === actor.subject &&
    row.subjectUserId !== actor.subject &&
    targetActive &&
    org?.status === 'active' &&
    Boolean(
      org.membershipRole &&
        actorMembershipRole &&
        actorPlatformRole &&
        !targetPlatformRole &&
        permission[mode],
    )
  return Object.freeze({
    actor,
    row,
    organization: org,
    actorMembershipRole,
    actorPlatformRole,
    targetPlatformRole,
    targetActive,
    permission,
    eligible,
    actorProfile: eligible
      ? Object.freeze({
          name: requiredString(data, 'actor_name'),
          email: requiredString(data, 'actor_email'),
        })
      : null,
    targetProfile: eligible
      ? Object.freeze({
          name: requiredString(data, 'target_name'),
          email: requiredString(data, 'target_email'),
        })
      : null,
  })
}

function resultValues(entry: unknown): readonly unknown[] {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('success' in entry) ||
    entry.success !== true ||
    !('results' in entry) ||
    !Array.isArray(entry.results)
  )
    throw unavailable()
  return entry.results
}

function results(entry: unknown): readonly AuthorizationRow[] {
  const rows = resultValues(entry)
  if (!rows.every(isRow)) throw unavailable()
  return rows
}

export function singleResult(entry: unknown): AuthorizationRow | null {
  const rows = results(entry)
  if (rows.length > 1) throw unavailable()
  return rows[0] ?? null
}

function readFact(
  entry: unknown,
  columns: readonly string[],
  maxRows: number,
): readonly AuthorizationRow[] {
  const rows = results(entry)
  if (rows.length > maxRows) throw unavailable()
  return Object.freeze(
    rows.map((row) => {
      const fact: Record<string, string | number | null> = {}
      for (const key of columns) {
        if (!Object.hasOwn(row, key)) throw unavailable()
        const value = row[key]
        if (
          value !== null &&
          typeof value !== 'string' &&
          !(typeof value === 'number' && Number.isFinite(value))
        )
          throw unavailable()
        fact[key] = value
      }
      return Object.freeze(fact)
    }),
  )
}

export const EMPTY_ROWS: readonly AuthorizationRow[] = Object.freeze([])
type Fact = AuthorizationFact<unknown>
export type FactResult = { compiled: CompiledFact; index: number }

export function productRows(
  batch: readonly unknown[],
  facts: ReadonlyMap<Fact, FactResult>,
  registrationIndex: number,
): (fact: Fact) => readonly AuthorizationRow[] {
  const values = new Map<Fact, readonly AuthorizationRow[]>()
  let registered: Set<string> | undefined
  return (fact) => {
    const pending = facts.get(fact)
    if (!pending) return EMPTY_ROWS
    const cached = values.get(fact)
    if (cached) return cached
    try {
      const { compiled, index } = pending
      if (compiled.productTable) {
        registered ??= new Set(
          resultValues(batch[registrationIndex]).flatMap((row) =>
            isRow(row) && typeof row.name === 'string' ? [row.name] : [],
          ),
        )
        if (!registered.has(compiled.table)) throw unavailable()
      }
      const rows = readFact(batch[index], compiled.columns, compiled.maxRows)
      if (
        compiled.projectionArity !== undefined &&
        !validProjectionRows(rows, compiled.projectionArity)
      )
        throw unavailable()
      values.set(fact, rows)
      return rows
    } catch {
      // Unreadable required rows are unavailable; do not attach private result data.
      throw unavailable()
    }
  }
}
