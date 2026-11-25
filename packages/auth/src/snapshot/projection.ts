import { AppError } from '@kit/core'
import type { AuthorizationRow } from './facts'
import { fields, invalid, record } from './scopes'

export type ProjectionScope = {
  kind: 'organization-role'
  /** Product column names holding the selected Organization and member's User IDs. */
  organizationId: string
  userId: string
}

export const PROJECTION_COLUMN = 'projection'

export function projectionScope(input: unknown): ProjectionScope {
  if (
    !(
      record(input) &&
      fields(input, ['kind', 'organizationId', 'userId']) &&
      Object.hasOwn(input, 'kind') &&
      Object.hasOwn(input, 'organizationId') &&
      Object.hasOwn(input, 'userId')
    )
  )
    return invalid()
  const { kind, organizationId, userId } = input
  if (
    kind !== 'organization-role' ||
    typeof organizationId !== 'string' ||
    typeof userId !== 'string'
  )
    return invalid()
  return { kind, organizationId, userId }
}

export function projectionQuery(source: string, selected: readonly string[]): string {
  const order = selected.map((column) => [column, 'COLLATE BINARY'].join(' ')).join(', ')
  // Pass the sorted JSON tuples as text. The final tie-breaker fixes the byte order even when
  // SQLite compares different encodings (such as integer 1 and real 1.0) as equal.
  const inner = ['SELECT json_array(', selected.join(', '), ') AS projection_tuple'].join('')
  return [
    "SELECT '[' || coalesce(group_concat(projection_tuple, ','), '') || ']' AS",
    PROJECTION_COLUMN,
    'FROM',
    ['(', inner, ' ', source, ' ORDER BY ', order, ', projection_tuple COLLATE BINARY)'].join(''),
  ].join(' ')
}

export function projectionText(rows: readonly AuthorizationRow[]): string {
  const value = rows[0]?.[PROJECTION_COLUMN]
  if (rows.length !== 1 || typeof value !== 'string')
    throw new AppError('INTERNAL_ERROR', 'Authorization unavailable', 503)
  return value
}

/** Called once when caching a successful batch result. The original text is never reserialized. */
export function validProjectionRows(rows: readonly AuthorizationRow[], arity: number): boolean {
  const tuples: unknown = JSON.parse(projectionText(rows))
  if (!Array.isArray(tuples)) return false
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length !== arity) return false
    for (const value of tuple) {
      if (
        value !== null &&
        typeof value !== 'string' &&
        !(typeof value === 'number' && Number.isFinite(value))
      )
        return false
    }
  }
  return true
}
