import {
  type AuthorizationFactScope,
  compileScope,
  fields,
  invalid,
  type ProjectColumn,
  record,
} from './scopes'

export type AuthorizationRow = Readonly<Record<string, string | number | null>>

type Value = string | number | boolean | null

type Declaration<T> = {
  /** The SQL table name and the closed set of columns registered for authorization reads. */
  table: { name: string; columns: readonly string[] }
  scope: AuthorizationFactScope
  select: readonly string[]
  where?: Readonly<Record<string, Value>>
  maxRows?: number
  decode: (rows: readonly AuthorizationRow[]) => T
}

declare const authorizationFact: unique symbol

export type AuthorizationFact<T> = Readonly<{
  [authorizationFact]: true
  scope: Readonly<AuthorizationFactScope>
  decode: (rows: readonly AuthorizationRow[]) => T
}>

export const MAX_FACTS = 24
const MAX_COLUMNS = 24
const MAX_ROWS = 128

// Kit tables are closed unless this list explicitly exposes a non-secret projection.
const kitColumns: Readonly<Record<string, readonly string[]>> = {
  user: ['id', 'name', 'email', 'email_verified', 'image', 'disabled', 'created_at', 'updated_at'],
  organization: [
    'id',
    'name',
    'slug',
    'logo',
    'metadata',
    'created_at',
    'updated_at',
    'kind',
    'status',
  ],
  member: ['id', 'organization_id', 'user_id', 'role', 'created_at'],
  organization_modules: [
    'organization_id',
    'module_id',
    'enabled',
    'locked',
    'updated_at',
    'available',
  ],
  organization_roles: ['id', 'organization_id', 'key', 'name', 'is_system', 'created_at'],
  organization_role_module_grants: ['role_id', 'module_id', 'access'],
}
const privateTables =
  /^(?:account|session|verification|api_keys|invitation|jwks|kit_modules|user_platform_roles|platform_modules|rate_limit_buckets|audit_events|d1_migrations|impersonation_role_permissions|impersonation_sessions|oauth_client|oauth_resource|oauth_client_resource|oauth_refresh_token|oauth_access_token|oauth_consent|oauth_client_assertion|oidc_session_authentication)$/i
const identifier = /^[a-z_][a-z0-9_]{0,62}$/i
const internalTable = /^(?:sqlite_|_cf_|__kit_|kit_notification_)/i
const secretColumn = /token|password|secret|credential|hash|salt|(?:api|private|signing)_?key/i
const hiddenColumn = /^(?:rowid|_rowid_|oid|__proto__|constructor|prototype)$/i

function quotedIdentifier(name: string): string {
  if (!identifier.test(name) || hiddenColumn.test(name)) return invalid()
  return `"${name}"`
}

function columnNames(values: unknown, limit: number): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > limit) return invalid()
  const seen = new Set<string>()
  return Array.from(values, (name: unknown) => {
    if (typeof name !== 'string' || !identifier.test(name) || hiddenColumn.test(name))
      return invalid()
    const canonical = name.toLowerCase()
    if (seen.has(canonical)) return invalid()
    seen.add(canonical)
    return name
  })
}

export type CompiledFact = Readonly<{
  table: string
  productTable: boolean
  sql: string
  values: readonly Value[]
  columns: readonly string[]
  maxRows: number
}>

const declarations = new WeakMap<AuthorizationFact<unknown>, CompiledFact>()

export function compiledAuthorizationFact(fact: AuthorizationFact<unknown>): CompiledFact {
  return declarations.get(fact) ?? invalid()
}

function compileTable(input: Declaration<unknown>['table']) {
  if (!record(input)) return invalid()
  if (typeof input.name !== 'string' || !fields(input, ['name', 'columns'])) return invalid()
  const quoted = quotedIdentifier(input.name)
  const table = input.name.toLowerCase()
  if (privateTables.test(table) || internalTable.test(table)) return invalid()
  const kitProjection = Object.hasOwn(kitColumns, table) ? kitColumns[table] : undefined
  const registered = new Set(
    columnNames(input.columns, MAX_COLUMNS).map((name) => name.toLowerCase()),
  )
  for (const name of registered) {
    if (kitProjection ? !kitProjection.includes(name) : secretColumn.test(name)) return invalid()
  }
  const availabilityJoin = table === 'organization_modules' && registered.has('available')
  const column: ProjectColumn = (name) => {
    if (typeof name !== 'string' || !registered.has(name.toLowerCase())) return invalid()
    if (availabilityJoin && name.toLowerCase() === 'available') return 'deployment."available"'
    return ['fact', quotedIdentifier(name)].join('.')
  }
  const from = ['main.', quoted, ' AS fact']
  if (availabilityJoin) {
    from.push(
      ' LEFT JOIN main."platform_modules" AS deployment ON deployment.module_id = fact.module_id',
    )
  }
  if (!kitProjection) {
    // SQLite preserves CROSS JOIN loop order, so a view or virtual table is not read.
    from.unshift(
      "(SELECT name FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE AND type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' LIMIT 1) AS registered CROSS JOIN ",
    )
  }
  return { table, productTable: !kitProjection, from: from.join(''), column }
}

function sqliteParameter(value: unknown): number | string {
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 2048) return value
  return invalid()
}

function compileFilters(
  where: Declaration<unknown>['where'],
  column: ProjectColumn,
  predicates: string[],
  values: Value[],
): void {
  if (where === undefined) return
  if (!record(where)) invalid()
  const keys = Object.keys(where)
  if (keys.length > MAX_COLUMNS || !fields(where, keys)) invalid()
  for (const [name, value] of Object.entries(where)) {
    const col = column(name)
    if (value === null) {
      predicates.push([col, 'IS NULL'].join(' '))
    } else {
      predicates.push([col, '= ?'].join(' '))
      values.push(sqliteParameter(value))
    }
  }
}

/** Compile a bounded, correlated SELECT. No caller-controlled SQL, ordering or operators. */
export function defineAuthorizationFact<T>(input: Declaration<T>): AuthorizationFact<T> {
  if (!record(input)) return invalid()
  if (
    typeof input.decode !== 'function' ||
    !fields(input, ['table', 'scope', 'select', 'where', 'maxRows', 'decode'])
  )
    return invalid()
  const { table, productTable, from, column } = compileTable(input.table)
  const { joins, predicates } = compileScope(table, input.scope, column)
  const columns = columnNames(input.select, MAX_COLUMNS)
  const projection = columns
    .map((name) => [column(name), 'AS', quotedIdentifier(name)].join(' '))
    .join(', ')
  const values: Value[] = productTable ? [table] : []
  compileFilters(input.where, column, predicates, values)
  const maxRows = input.maxRows === undefined ? 16 : input.maxRows
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) return invalid()
  // The extra row is an overflow indicator. The loader rejects rather than truncating.
  values.push(maxRows + 1)
  const sql = [
    'SELECT',
    projection,
    'FROM',
    from,
    'JOIN kit_candidate AS candidate',
    ...joins,
    'WHERE',
    predicates.join(' AND '),
    'LIMIT ?',
  ].join(' ')
  const fact = Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    decode: input.decode,
  }) as AuthorizationFact<T>
  declarations.set(
    fact,
    Object.freeze({
      table,
      productTable,
      sql,
      values: Object.freeze(values),
      columns: Object.freeze(columns),
      maxRows,
    }),
  )
  return fact
}
