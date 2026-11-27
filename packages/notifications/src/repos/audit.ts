import { AppError, decodeListCursor } from '@kit/core'
import * as z from 'zod'
import type { Selector } from '../types'
import type { AuditRow, RuleScope } from './types'
import {
  epochMsSchema,
  identitySchema,
  listQuerySchema,
  parseRepositoryInput,
  rowIdSchema,
} from './validation'

export const scopeSchema = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('deployment') }),
  z.strictObject({ level: z.literal('organization'), orgId: identitySchema }),
  z.strictObject({ level: z.literal('user'), userId: identitySchema }),
])
const auditSchema = z.strictObject({
  id: identitySchema,
  actorUserId: identitySchema,
  orgId: identitySchema.nullable(),
  targetId: rowIdSchema,
  action: z.string(),
  meta: z.record(z.string(), z.json()),
  createdAt: epochMsSchema,
})

export function checkedAudit(
  value: unknown,
  orgId: string | null,
  targetId: string,
  action: string,
): AuditRow {
  const audit = parseRepositoryInput(auditSchema, value)
  if (audit.orgId !== orgId || audit.targetId !== targetId || audit.action !== action) {
    throw AppError.validation('Invalid notification audit')
  }
  return audit
}

export function ruleAudit(
  value: unknown,
  scope: RuleScope,
  targetId: string,
  action: string,
): AuditRow | undefined {
  if (scope.level === 'user') {
    if (value !== undefined) throw AppError.validation('User rule cannot be audited')
    return undefined
  }
  return checkedAudit(value, scope.level === 'organization' ? scope.orgId : null, targetId, action)
}

export function selectorValue(selector: Selector): string {
  return selector.kind === 'all' ? '*' : selector.value
}
export function selectorFrom(kind: string, value: string): Selector {
  if (kind === 'all') return { kind: 'all' }
  return { kind: kind as 'type' | 'category', value }
}

export function pageInput(input: unknown) {
  const query = parseRepositoryInput(listQuerySchema, input)
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseRepositoryInput(
          z.strictObject({ createdAt: epochMsSchema, id: rowIdSchema }),
          decodeListCursor(query.cursor),
        )
  return { limit: query.limit ?? 50, cursor }
}
