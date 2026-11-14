import { auditEvents } from '@kit/auth/schema'
import { AppError, takeListPage } from '@kit/core'
import type { ListQuery } from '@kit/types'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  kitNotificationDeploymentRules as deployment,
  kitNotificationOrganizationRules as organization,
  kitNotificationUserRules as user,
} from '../drizzle-schema'
import { pageInput, ruleAudit, scopeSchema, selectorFrom, selectorValue } from './audit'
import type { AuditRow, Db, RuleRow, RuleScope } from './types'
import {
  channelKeySchema,
  epochMsSchema,
  parseRepositoryInput,
  rowIdSchema,
  selectorSchema,
} from './validation'

const ruleSchema = z.strictObject({
  id: rowIdSchema,
  selector: selectorSchema,
  channel: channelKeySchema,
  enabled: z.boolean(),
  locked: z.boolean(),
})
type SharedRuleTable = {
  $inferSelect: typeof deployment.$inferSelect
  $inferInsert: typeof deployment.$inferInsert
}

function config(scope: RuleScope) {
  if (scope.level === 'organization')
    return {
      table: organization satisfies SharedRuleTable,
      owner: eq(organization.orgId, scope.orgId),
      ownerValue: { orgId: scope.orgId },
      target: [
        organization.orgId,
        organization.selectorKind,
        organization.selectorValue,
        organization.channel,
      ],
    }
  if (scope.level === 'user')
    return {
      table: user satisfies SharedRuleTable,
      owner: eq(user.userId, scope.userId),
      ownerValue: { userId: scope.userId },
      target: [user.userId, user.selectorKind, user.selectorValue, user.channel],
    }
  return {
    table: deployment,
    owner: undefined,
    ownerValue: {},
    target: [deployment.selectorKind, deployment.selectorValue, deployment.channel],
  }
}
function mapRule(row: typeof deployment.$inferSelect): RuleRow {
  return {
    id: row.id,
    selector: selectorFrom(row.selectorKind, row.selectorValue),
    channel: row.channel,
    enabled: row.enabled,
    locked: row.locked,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listRules(db: Db, inputScope: RuleScope, inputQuery: ListQuery) {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const { table, owner } = config(scope)
  const { limit, cursor } = pageInput(inputQuery)
  const seek =
    cursor &&
    or(
      lt(table.createdAt, cursor.createdAt),
      and(eq(table.createdAt, cursor.createdAt), lt(table.id, cursor.id)),
    )
  const rows = await db
    .select()
    .from(table)
    .where(and(owner, seek || undefined))
    .orderBy(desc(table.createdAt), desc(table.id))
    .limit(limit + 1)
  return takeListPage(rows.map(mapRule), limit, (row) => ({ createdAt: row.createdAt, id: row.id }))
}

export async function putRule(
  db: Db,
  inputScope: RuleScope,
  inputRule: Omit<RuleRow, 'createdAt' | 'updatedAt'>,
  inputNow: number,
  inputAudit?: AuditRow,
): Promise<RuleRow> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const rule = parseRepositoryInput(ruleSchema, inputRule)
  const now = parseRepositoryInput(epochMsSchema, inputNow)
  if (
    (scope.level === 'user' && rule.locked) ||
    (rule.channel === 'email' && rule.enabled && rule.locked)
  )
    throw AppError.validation('Invalid rule')
  const audit = ruleAudit(inputAudit, scope, rule.id, 'notification.rule.set')
  const { table, owner, ownerValue, target } = config(scope)
  const value = selectorValue(rule.selector)
  const natural = and(
    owner,
    eq(table.selectorKind, rule.selector.kind),
    eq(table.selectorValue, value),
    eq(table.channel, rule.channel),
  )
  const mutation = db
    .insert(table)
    .values({
      id: rule.id,
      selectorKind: rule.selector.kind,
      selectorValue: value,
      channel: rule.channel,
      enabled: rule.enabled,
      locked: rule.locked,
      createdAt: now,
      updatedAt: now,
      ...ownerValue,
    })
    .onConflictDoUpdate({
      target,
      set: { enabled: rule.enabled, locked: rule.locked, updatedAt: now },
      setWhere: or(
        sql`${table.enabled} <> excluded.enabled`,
        sql`${table.locked} <> excluded.locked`,
      ),
    })
  const read = db.select().from(table).where(natural)
  if (!audit) {
    const [, rows] = await db.batch([mutation, read])
    return mapRule(rows[0]!)
  }
  const meta = JSON.stringify({
    selectorKind: rule.selector.kind,
    selectorValue: value,
    channel: rule.channel,
    enabled: rule.enabled,
    locked: rule.locked,
  })
  const insert = db.insert(auditEvents).select(
    db
      .select({
        id: sql<string>`${audit.id}`.as('id'),
        createdAt: sql<number>`${audit.createdAt}`.as('created_at'),
        actorUserId: sql<string>`${audit.actorUserId}`.as('actor_user_id'),
        action: sql<string>`${audit.action}`.as('action'),
        targetType: sql<string>`'notification.rule'`.as('target_type'),
        targetId: table.id,
        orgId: sql<string | null>`${audit.orgId}`.as('org_id'),
        ip: sql<string | null>`null`.as('ip'),
        metaJson: sql<string>`${meta}`.as('meta_json'),
      })
      .from(table)
      .where(and(natural, sql`changes() > 0`)),
  )
  const [, , rows] = await db.batch([mutation, insert, read])
  return mapRule(rows[0]!)
}

export async function deleteRule(
  db: Db,
  inputScope: RuleScope,
  inputId: string,
  inputAudit?: AuditRow,
): Promise<boolean> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const id = parseRepositoryInput(rowIdSchema, inputId)
  const audit = ruleAudit(inputAudit, scope, id, 'notification.rule.delete')
  const { table, owner } = config(scope)
  const where = and(owner, eq(table.id, id))
  const remove = db.delete(table).where(where).returning({ id: table.id })
  if (!audit) return (await remove).length > 0
  const meta = sql<string>`json_object('selectorKind',${table.selectorKind},'selectorValue',${table.selectorValue},'channel',${table.channel},'enabled',json(CASE WHEN ${table.enabled} THEN 'true' ELSE 'false' END),'locked',json(CASE WHEN ${table.locked} THEN 'true' ELSE 'false' END))`
  const insert = db.insert(auditEvents).select(
    db
      .select({
        id: sql<string>`${audit.id}`.as('id'),
        createdAt: sql<number>`${audit.createdAt}`.as('created_at'),
        actorUserId: sql<string>`${audit.actorUserId}`.as('actor_user_id'),
        action: sql<string>`${audit.action}`.as('action'),
        targetType: sql<string>`'notification.rule'`.as('target_type'),
        targetId: table.id,
        orgId: sql<string | null>`${audit.orgId}`.as('org_id'),
        ip: sql<string | null>`null`.as('ip'),
        metaJson: meta.as('meta_json'),
      })
      .from(table)
      .where(where),
  )
  const [, rows] = await db.batch([insert, remove])
  return rows.length > 0
}
