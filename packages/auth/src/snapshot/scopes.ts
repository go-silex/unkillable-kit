type RoleScope = {
  kind: 'organization-role' | 'delegated-role'
  roleId?: string
  organizationId?: string
  userId?: string
}

export type AuthorizationFactScope =
  | { kind: 'user'; userId: string }
  | { kind: 'organization'; organizationId: string }
  | RoleScope
  | { kind: 'delegated-user'; organizationId: string; userId: string }
  | { kind: 'hosted-grant'; userId: string; grantId: string; clientId: string }

export function fields(object: object, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(object).every((key) => typeof key === 'string' && allowed.includes(key))
}

export function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

export function invalid(): never {
  throw new TypeError('Invalid authorization fact declaration')
}

export type ProjectColumn = (name: unknown) => string

type Correlation = {
  anchors: [unknown, string][]
  joins: string[]
  predicates: string[]
}

function correlateRole(
  scope: Record<string, unknown>,
  subject: string,
  { joins, anchors }: Pick<Correlation, 'joins' | 'anchors'>,
): void {
  joins.push(
    [
      'JOIN main."member" AS membership ON membership.organization_id = org.id AND membership.user_id =',
      subject,
    ].join(' '),
  )
  if (scope.roleId !== undefined) {
    joins.push(
      'JOIN main."organization_roles" AS role ON role.organization_id = org.id AND role.key = membership.role',
    )
    anchors.push([scope.roleId, 'role.id'])
  } else if (scope.organizationId === undefined || scope.userId === undefined) {
    invalid()
  }
}

function organizationScope(
  scope: Record<string, unknown>,
  roleScope: boolean,
  delegated: boolean,
): Correlation {
  const allowed = ['kind', 'organizationId']
  if (roleScope || delegated) allowed.push('userId')
  if (roleScope) allowed.push('roleId')
  if (!fields(scope, allowed)) return invalid()
  const joins = ['JOIN main."organization" AS org ON org.id = candidate.selected_org']
  const predicates = ['(candidate.key_org IS NULL OR candidate.key_org = org.id)']
  const anchors: Correlation['anchors'] = []
  const subject = delegated ? 'delegation.target_id' : 'candidate.subject'
  if (delegated) {
    joins.push('JOIN kit_delegated AS delegation ON delegation.session_id = candidate.session_id')
    predicates.push('delegation.organization_id = candidate.selected_org')
  }
  if (roleScope) correlateRole(scope, subject, { anchors, joins })
  if (scope.organizationId !== undefined || !roleScope)
    anchors.push([scope.organizationId, 'org.id'])
  if (Object.hasOwn(scope, 'userId') || (delegated && !roleScope))
    anchors.push([scope.userId, subject])
  return { anchors, joins, predicates }
}

function candidateScope(scope: Record<string, unknown>): Correlation {
  switch (scope.kind) {
    case 'user':
      if (!fields(scope, ['kind', 'userId'])) return invalid()
      return { anchors: [[scope.userId, 'candidate.subject']], joins: [], predicates: [] }
    case 'organization':
      return organizationScope(scope, false, false)
    case 'organization-role':
      return organizationScope(scope, true, false)
    case 'delegated-user':
      return organizationScope(scope, false, true)
    case 'delegated-role':
      return organizationScope(scope, true, true)
    case 'hosted-grant':
      if (!fields(scope, ['kind', 'userId', 'grantId', 'clientId'])) return invalid()
      return {
        anchors: [
          [scope.userId, 'candidate.subject'],
          [scope.grantId, 'candidate.grant_id'],
          [scope.clientId, 'candidate.client_id'],
        ],
        joins: [],
        predicates: [],
      }
    default:
      return invalid()
  }
}

// Kit projections must correlate on the Kit's actual keys, not arbitrary alias columns.
function validKitScope(table: string, scope: Record<string, unknown>): boolean {
  const { kind, roleId, organizationId, userId } = scope
  const roleScope = kind === 'organization-role' || kind === 'delegated-role'
  switch (table) {
    case 'user':
      return kind === 'user' && userId === 'id'
    case 'organization':
      return kind === 'organization' && organizationId === 'id'
    case 'organization_modules':
      return kind === 'organization' && organizationId === 'organization_id'
    case 'member':
      return (
        (roleScope || kind === 'delegated-user') &&
        organizationId === 'organization_id' &&
        userId === 'user_id' &&
        !Object.hasOwn(scope, 'roleId')
      )
    case 'organization_roles':
      return (
        (kind === 'organization' && organizationId === 'organization_id') ||
        (roleScope && roleId === 'id' && !Object.hasOwn(scope, 'userId'))
      )
    case 'organization_role_module_grants':
      return (
        roleScope &&
        roleId === 'role_id' &&
        !Object.hasOwn(scope, 'userId') &&
        !Object.hasOwn(scope, 'organizationId')
      )
    default:
      return true
  }
}

export function compileScope(table: string, scope: AuthorizationFactScope, column: ProjectColumn) {
  if (!record(scope)) return invalid()
  if (!(Object.hasOwn(scope, 'kind') && validKitScope(table, scope))) return invalid()
  const { anchors, joins, predicates } = candidateScope(scope)
  const used = new Set<string>()
  for (const [name, key] of anchors) {
    if (typeof name !== 'string' || used.has(name.toLowerCase())) return invalid()
    used.add(name.toLowerCase())
    predicates.push([column(name), '=', key].join(' '))
  }
  return { joins, predicates }
}
