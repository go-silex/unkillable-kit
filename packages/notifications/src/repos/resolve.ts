import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { lifecycleBatch, lifecycleStatement } from './admit-sql'
import type { Db, ResolveInput, ResolveResult } from './types'
import {
  epochMsSchema,
  identitySchema,
  parseRepositoryInput,
  sourceRefSchema,
  typeKeySchema,
} from './validation'

const inputSchema = z.strictObject({
  orgId: identitySchema,
  source: sourceRefSchema,
  types: z.array(typeKeySchema).optional(),
  userIds: z.array(identitySchema).optional(),
  now: epochMsSchema,
})
export type ResolvePredicates = Readonly<{
  notifications: SQL
  organizationDeliveries: SQL
}>

const dialect = new SQLiteSyncDialect()

function resolutionScope(data: z.infer<typeof inputSchema>, predicates?: ResolvePredicates) {
  const typeFilter = data.types ? ' AND type_key IN (SELECT value FROM json_each(?))' : ''
  const userFilter = data.userIds ? ' AND user_id IN (SELECT value FROM json_each(?))' : ''
  const base = [data.orgId, data.source.kind, data.source.id]
  const types = data.types ? [JSON.stringify(data.types)] : []
  const users = data.userIds ? [JSON.stringify(data.userIds)] : []
  const notificationGuard = predicates && dialect.sqlToQuery(predicates.notifications)
  const collectiveGuard = predicates && dialect.sqlToQuery(predicates.organizationDeliveries)
  const common = `org_id=? AND source_kind=? AND source_id=? AND resolved_at IS NULL${typeFilter}`
  return {
    predicate: common + userFilter + (notificationGuard ? ` AND (${notificationGuard.sql})` : ''),
    notificationParams: [...base, ...types, ...users, ...(notificationGuard?.params ?? [])],
    collective: common + (collectiveGuard ? ` AND (${collectiveGuard.sql})` : ''),
    collectiveParams: [...base, ...types, ...(collectiveGuard?.params ?? [])],
  }
}

export async function resolveNotifications(
  db: Db,
  input: ResolveInput & { now: number },
  predicates?: ResolvePredicates,
): Promise<ResolveResult> {
  const data = parseRepositoryInput(inputSchema, input)
  if (data.types?.length === 0 || data.userIds?.length === 0) {
    return { resolvedNotifications: 0, skippedDeliveries: 0, resolvedOrganizationDeliveries: 0 }
  }
  const { predicate, notificationParams, collective, collectiveParams } = resolutionScope(
    data,
    predicates,
  )
  const statements = [
    lifecycleStatement(
      db,
      "UPDATE kit_notification_deliveries SET status='skipped',error_code='source_resolved',finished_at=? WHERE org_id=? AND status='pending' AND notification_id IN (SELECT id FROM kit_notifications WHERE " +
        predicate +
        ') RETURNING id',
      [data.now, data.orgId, ...notificationParams],
    ),
    lifecycleStatement(
      db,
      ['UPDATE kit_notifications SET resolved_at=? WHERE ', predicate, ' RETURNING id'].join(''),
      [data.now, ...notificationParams],
    ),
  ]
  if (!data.userIds) {
    statements.push(
      lifecycleStatement(
        db,
        "UPDATE kit_notification_organization_deliveries SET status='skipped',error_code='source_resolved',finished_at=? WHERE status='pending' AND " +
          collective +
          ' RETURNING id',
        [data.now, ...collectiveParams],
      ),
    )
    statements.push(
      lifecycleStatement(
        db,
        'UPDATE kit_notification_organization_deliveries SET resolved_at=? WHERE ' +
          collective +
          ' RETURNING id',
        [data.now, ...collectiveParams],
      ),
    )
  }
  const result = await lifecycleBatch(db, statements)
  return {
    resolvedNotifications: result[1]?.results.length ?? 0,
    skippedDeliveries: (result[0]?.results.length ?? 0) + (result[2]?.results.length ?? 0),
    resolvedOrganizationDeliveries: result[3]?.results.length ?? 0,
  }
}
