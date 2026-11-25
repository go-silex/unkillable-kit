import type { AuthorizationRow, CompiledFact } from './facts'
import { PROJECTION_COLUMN } from './projection'

const AUTHORITY_SECTION = 'section'
export const AVAILABILITY_SECTION = 0
export const GRANT_SECTION = 1
export const PROJECTION_SECTION = 2
export type AuthoritySection =
  | typeof AVAILABILITY_SECTION
  | typeof GRANT_SECTION
  | typeof PROJECTION_SECTION

export type AuthorityRows = [AuthorizationRow[], AuthorizationRow[], AuthorizationRow[]]

export function splitAuthorityRows(rows: readonly AuthorizationRow[]): AuthorityRows | undefined {
  const sections: AuthorityRows = [[], [], []]
  for (const row of rows) {
    const section = row[AUTHORITY_SECTION]
    if (
      !Object.hasOwn(row, AUTHORITY_SECTION) ||
      (section !== AVAILABILITY_SECTION &&
        section !== GRANT_SECTION &&
        section !== PROJECTION_SECTION)
    )
      return undefined
    sections[section].push(row)
  }
  return sections
}

export function authorityColumn(index: number): string {
  return `value_${index}`
}

export type AuthorityQuery = { sql: string; values: CompiledFact['values'] }

function policyPrerequisite(availability: CompiledFact, grant: CompiledFact): string {
  const enabledIndex = availability.columns.indexOf('enabled')
  const availableIndex = availability.columns.indexOf('available')
  const accessIndex = grant.columns.indexOf('access')
  // Do not reference a column the descriptor didn't select. The ordinary Module guard
  // will see the same raw results and handle the malformed policy as usual.
  if (enabledIndex === -1 || availableIndex === -1 || accessIndex === -1) return '0'
  const flags = [enabledIndex, availableIndex].map((index) => {
    const column = authorityColumn(index)
    return ['typeof(', column, ") IN ('integer', 'real') AND ", column, ' = 1'].join('')
  })
  return [
    '(SELECT count(*) FROM availability_rows) = 1',
    ['EXISTS (SELECT 1 FROM availability_rows WHERE', flags.join(' AND '), ')'].join(' '),
    '(SELECT count(*) FROM grant_rows) = 1',
    [
      'EXISTS (SELECT 1 FROM grant_rows WHERE',
      authorityColumn(accessIndex),
      "COLLATE BINARY IN ('read', 'write'))",
    ].join(' '),
  ].join(' AND ')
}

export function authorityBatchQuery(
  source: AuthorityQuery,
  availability: CompiledFact,
  grant: CompiledFact,
  projection: CompiledFact,
): AuthorityQuery {
  const width = Math.max(availability.columns.length, grant.columns.length)
  const slots = Array.from({ length: width }, (_slot, index) => authorityColumn(index))
  const availabilityColumns = slots.slice(0, availability.columns.length)
  const grantColumns = slots.slice(0, grant.columns.length)
  const availabilityValues = slots.map((slot, index) =>
    index < availability.columns.length ? slot : ['NULL AS', slot].join(' '),
  )
  const grantValues = slots.map((slot, index) => (index < grant.columns.length ? slot : 'NULL'))
  const sql = [
    'WITH',
    source.sql,
    ', availability_rows(',
    availabilityColumns.join(', '),
    ') AS MATERIALIZED (',
    availability.sql,
    '), grant_rows(',
    grantColumns.join(', '),
    ') AS MATERIALIZED (',
    grant.sql,
    ')',
    'SELECT',
    AVAILABILITY_SECTION,
    'AS',
    AUTHORITY_SECTION,
    ',',
    availabilityValues.join(', '),
    ', NULL AS',
    PROJECTION_COLUMN,
    'FROM availability_rows UNION ALL SELECT',
    GRANT_SECTION,
    ',',
    grantValues.join(', '),
    ', NULL',
    'FROM grant_rows UNION ALL SELECT',
    PROJECTION_SECTION,
    ', NULL'.repeat(width),
    ', CASE WHEN',
    policyPrerequisite(availability, grant),
    'THEN (',
    projection.sql,
    ') ELSE NULL END',
  ].join(' ')
  return {
    sql,
    values: [...source.values, ...availability.values, ...grant.values, ...projection.values],
  }
}
