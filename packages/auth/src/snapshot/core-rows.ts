import { AppError } from '@kit/core'
import { isModuleAccess, type ModuleAccess } from '../module-grants'
import {
  isPlatformRole,
  ORG_KINDS,
  ORG_STATUSES,
  type OrgKind,
  type OrgStatus,
  type PlatformRole,
} from '../org-roles'
import type { ImpersonationSession } from '../repos/impersonation'
import type { ApiKeyScope, SessionAuthIdentity } from '../require-auth'

export type Profile = Readonly<{ name: string; email: string }>
export type ImpersonationPermissions = Readonly<{ read: boolean; write: boolean }>
export type SessionIdentity = Readonly<SessionAuthIdentity & { email: string }>
export type HostedIdentity = Readonly<{
  method: 'mcp'
  subject: string
  grantId?: string
  clientId?: string
}>
export type Identity =
  | SessionIdentity
  | HostedIdentity
  | Readonly<{
      method: 'api_key'
      subject: string
      organizationId: string
      scopes: readonly ApiKeyScope[]
    }>

export type Organization = Readonly<{
  id: string
  kind: OrgKind
  status: OrgStatus
  role: string | null
}>
export type ModuleEntry = Readonly<{ available: boolean; access: ModuleAccess | null }>
export type Modules = ReadonlyMap<string, ModuleEntry> | 'disabled'
export type Delegation = Readonly<{
  actor: SessionIdentity
  row: Readonly<ImpersonationSession>
  organization: Organization | null
  actorMembershipRole: string | null
  actorPlatformRole: PlatformRole | null
  targetPlatformRole: PlatformRole | null
  targetActive: boolean
  permission: boolean
  eligible: boolean
  actorProfile: Profile | null
  targetProfile: Profile | null
}>

type Row = Record<string, unknown>

export function unavailable(): AppError {
  return new AppError('INTERNAL_ERROR', 'Authorization unavailable', 503)
}

export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/^\s|\s$/u.test(value) &&
    !value.includes('\0')
  )
}

export function identifier(value: unknown): string {
  if (!isIdentifier(value)) throw unavailable()
  return value
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw unavailable()
  return value
}

export function role(value: unknown) {
  if (value === null) return null
  const name = text(value)
  return isPlatformRole(name) ? name : null
}

export function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw unavailable()
  return value === 1
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw unavailable()
  return value
}

const nullableId = (value: unknown) => (value === null ? null : identifier(value))

export function organization(row: Row, membership: unknown): Organization | null {
  const id = nullableId(row.org_id)
  if (id === null) return null
  const kind = text(row.org_kind) as OrgKind
  const status = text(row.org_status) as OrgStatus
  if (!(ORG_KINDS.includes(kind) && ORG_STATUSES.includes(status))) throw unavailable()
  return Object.freeze({ id, kind, status, role: nullableId(membership) })
}

export function sessionIdentity(
  subject: string,
  sessionId: unknown,
  email: unknown,
): SessionIdentity {
  return Object.freeze({
    method: 'session',
    subject,
    sessionId: identifier(sessionId),
    email: text(email),
  })
}

function decodeImpersonationPermissions(data: Row): ImpersonationPermissions {
  return Object.freeze({
    read: data.permit_read !== null && flag(data.permit_read),
    write: data.permit_write !== null && flag(data.permit_write),
  })
}

export function decodeImpersonation(data: Row | null, now: number) {
  if (!data || flag(data.actor_disabled) || integer(data.session_expiry) < now)
    return { permissions: null, delegation: null }
  const permissions = decodeImpersonationPermissions(data)
  return { permissions, delegation: data.id === null ? null : decodeDelegation(data, permissions) }
}

function decodeDelegation(data: Row, permissions: ImpersonationPermissions): Delegation {
  const actor = sessionIdentity(identifier(data.actor), data.session_id, data.actor_email)
  const mode = text(data.mode)
  if (mode !== 'read' && mode !== 'write') throw unavailable()
  const row = Object.freeze({
    id: identifier(data.id),
    sessionId: actor.sessionId,
    actorUserId: identifier(data.actor_user_id),
    subjectUserId: identifier(data.target_id),
    organizationId: identifier(data.organization_id),
    mode,
    createdAt: integer(data.created_at),
  })
  const org = organization(data, data.target_membership_role)
  const actorMembershipRole = nullableId(data.actor_membership_role)
  const actorPlatformRole = role(data.actor_platform_role)
  const targetPlatformRole = role(data.target_platform_role)
  const targetActive = data.target_disabled !== null && !flag(data.target_disabled)
  const permission = permissions[mode]
  const eligible =
    row.actorUserId === actor.subject &&
    row.subjectUserId !== actor.subject &&
    targetActive &&
    org?.status === 'active' &&
    Boolean(
      org.role && actorMembershipRole && actorPlatformRole && !targetPlatformRole && permission,
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
    eligible: Boolean(eligible),
    actorProfile: eligible
      ? Object.freeze({ name: text(data.actor_name), email: text(data.actor_email) })
      : null,
    targetProfile: eligible
      ? Object.freeze({ name: text(data.target_name), email: text(data.target_email) })
      : null,
  })
}

export function resultRows(entry: unknown): readonly Row[] {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('success' in entry) ||
    entry.success !== true ||
    !('results' in entry) ||
    !Array.isArray(entry.results) ||
    !entry.results.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  )
    throw unavailable()
  return entry.results
}

export function singleResult(entry: unknown): Row | null {
  const rows = resultRows(entry)
  if (rows.length > 1) throw unavailable()
  return rows[0] ?? null
}

// Freezing a native Map does not freeze its entries or hide its mutating methods.
function readOnlyModules(map: Map<string, ModuleEntry>): ReadonlyMap<string, ModuleEntry> {
  const view: ReadonlyMap<string, ModuleEntry> = Object.freeze({
    size: map.size,
    get: (id: string) => map.get(id),
    has: (id: string) => map.has(id),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map.entries(),
    forEach: (
      callback: (entry: ModuleEntry, id: string, modules: ReadonlyMap<string, ModuleEntry>) => void,
      thisArg?: unknown,
    ) => {
      for (const [id, entry] of map) callback.call(thisArg, entry, id, view)
    },
  })
  return view
}

export const EMPTY_MODULES = readOnlyModules(new Map())

export function decodeModules(rows: readonly Row[]): ReadonlyMap<string, ModuleEntry> {
  if (!rows.length) return EMPTY_MODULES
  const map = new Map<string, ModuleEntry>()
  for (const row of rows) {
    const id = identifier(row.module_id)
    if (map.has(id)) throw unavailable()
    const enabled = flag(row.enabled)
    const available = row.available !== null && flag(row.available)
    const access = row.access === null ? null : text(row.access)
    if (access !== null && !isModuleAccess(access)) throw unavailable()
    map.set(id, Object.freeze({ available: enabled && available, access }))
  }
  return readOnlyModules(map)
}
