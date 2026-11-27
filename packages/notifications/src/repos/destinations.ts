import { auditEvents } from '@kit/auth/schema'
import { AppError, takeListPage } from '@kit/core'
import type { ListQuery } from '@kit/types'
import { and, desc, eq, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import * as z from 'zod'
import { kitNotificationDestinations as destinations } from '../drizzle-schema'
import { checkedAudit, pageInput, selectorFrom, selectorValue } from './audit'
import type { AuditRow, Db, DestinationRow } from './types'
import {
  channelKeySchema,
  epochMsSchema,
  identitySchema,
  parseRepositoryInput,
  rowIdSchema,
  selectorSchema,
} from './validation'

const createSchema = z.strictObject({
  orgId: identitySchema,
  id: rowIdSchema,
  channel: channelKeySchema,
  externalId: z.string().min(1).max(1024),
  selector: selectorSchema,
  now: epochMsSchema,
  audit: z.unknown(),
})
const updateSchema = z.strictObject({
  orgId: identitySchema,
  id: rowIdSchema,
  selector: selectorSchema,
  now: epochMsSchema,
  audit: z.unknown(),
})
function mapDestination(row: typeof destinations.$inferSelect): DestinationRow {
  return {
    id: row.id,
    orgId: row.orgId,
    channel: row.channel,
    externalId: row.externalId,
    selector: selectorFrom(row.selectorKind, row.selectorValue),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
function auditStatement(db: Db, audit: AuditRow, predicate: SQL | undefined) {
  const meta = sql<string>`CASE WHEN ${destinations.channel} = 'slack' THEN
    CASE WHEN ${destinations.selectorKind} = 'all' THEN json_object('installationId',json_extract(${destinations.externalId},'$[1]'),'slackChannelId',json_extract(${destinations.externalId},'$[2]'),'selectorKind',${destinations.selectorKind})
    ELSE json_object('installationId',json_extract(${destinations.externalId},'$[1]'),'slackChannelId',json_extract(${destinations.externalId},'$[2]'),'selectorKind',${destinations.selectorKind},'selectorValue',${destinations.selectorValue}) END
    ELSE CASE WHEN ${destinations.selectorKind} = 'all' THEN json_object('selectorKind',${destinations.selectorKind}) ELSE json_object('selectorKind',${destinations.selectorKind},'selectorValue',${destinations.selectorValue}) END END`
  return db.insert(auditEvents).select(
    db
      .select({
        id: sql<string>`${audit.id}`.as('id'),
        createdAt: sql<number>`${audit.createdAt}`.as('created_at'),
        actorUserId: sql<string>`${audit.actorUserId}`.as('actor_user_id'),
        action: sql<string>`${audit.action}`.as('action'),
        targetType: sql<string>`'notification.destination'`.as('target_type'),
        targetId: destinations.id,
        orgId: sql<string | null>`${audit.orgId}`.as('org_id'),
        ip: sql<string | null>`null`.as('ip'),
        metaJson: meta.as('meta_json'),
      })
      .from(destinations)
      .where(predicate),
  )
}

export async function createDestination(
  db: Db,
  input: {
    orgId: string
    id: string
    channel: string
    externalId: string
    selector: DestinationRow['selector']
    now: number
    audit: AuditRow
  },
): Promise<DestinationRow> {
  const value = parseRepositoryInput(createSchema, input)
  const audit = checkedAudit(value.audit, value.orgId, value.id, 'slack.destination_created')
  if (value.channel === 'slack') {
    let address: unknown
    try {
      address = JSON.parse(value.externalId)
    } catch {
      throw AppError.validation('Invalid destination address')
    }
    const tuple = parseRepositoryInput(
      z.tuple([z.literal('slack'), z.string().min(1).max(1024), z.string().min(1).max(1024)]),
      address,
    )
    if (JSON.stringify(tuple) !== value.externalId)
      throw AppError.validation('Invalid destination address')
  }
  const mutation = db
    .insert(destinations)
    .values({
      id: value.id,
      orgId: value.orgId,
      channel: value.channel,
      externalId: value.externalId,
      selectorKind: value.selector.kind,
      selectorValue: selectorValue(value.selector),
      createdAt: value.now,
      updatedAt: value.now,
    })
    .onConflictDoNothing({
      target: [destinations.orgId, destinations.channel, destinations.externalId],
    })
    .returning()
  const condition = and(
    eq(destinations.orgId, value.orgId),
    eq(destinations.id, value.id),
    sql`changes() > 0`,
  )
  const [rows] = await db.batch([mutation, auditStatement(db, audit, condition)])
  if (!rows.length) throw AppError.conflict('Destination already exists')
  return mapDestination(rows[0]!)
}

export async function updateDestinationSelector(
  db: Db,
  input: {
    orgId: string
    id: string
    selector: DestinationRow['selector']
    now: number
    audit: AuditRow
  },
): Promise<DestinationRow | null> {
  const value = parseRepositoryInput(updateSchema, input)
  const audit = checkedAudit(value.audit, value.orgId, value.id, 'slack.destination_updated')
  const selector = selectorValue(value.selector)
  const owner = and(eq(destinations.orgId, value.orgId), eq(destinations.id, value.id))
  const mutation = db
    .update(destinations)
    .set({ selectorKind: value.selector.kind, selectorValue: selector, updatedAt: value.now })
    .where(
      and(
        owner,
        or(
          ne(destinations.selectorKind, value.selector.kind),
          ne(destinations.selectorValue, selector),
        ),
      ),
    )
  const insert = auditStatement(db, audit, and(owner, sql`changes() > 0`))
  const read = db.select().from(destinations).where(owner)
  const [, , rows] = await db.batch([mutation, insert, read])
  return rows[0] ? mapDestination(rows[0]) : null
}

export async function listDestinations(db: Db, inputOrgId: string, inputQuery: ListQuery) {
  const orgId = parseRepositoryInput(identitySchema, inputOrgId)
  const { limit, cursor } = pageInput(inputQuery)
  const seek =
    cursor &&
    or(
      lt(destinations.createdAt, cursor.createdAt),
      and(eq(destinations.createdAt, cursor.createdAt), lt(destinations.id, cursor.id)),
    )
  const rows = await db
    .select()
    .from(destinations)
    .where(and(eq(destinations.orgId, orgId), seek || undefined))
    .orderBy(desc(destinations.createdAt), desc(destinations.id))
    .limit(limit + 1)
  return takeListPage(rows.map(mapDestination), limit, (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }))
}

export async function deleteDestination(
  db: Db,
  inputOrgId: string,
  inputId: string,
  inputAudit: AuditRow,
): Promise<boolean> {
  const orgId = parseRepositoryInput(identitySchema, inputOrgId)
  const id = parseRepositoryInput(rowIdSchema, inputId)
  const audit = checkedAudit(inputAudit, orgId, id, 'slack.destination_deleted')
  const owner = and(eq(destinations.orgId, orgId), eq(destinations.id, id))
  const [, rows] = await db.batch([
    auditStatement(db, audit, owner),
    db.delete(destinations).where(owner).returning({ id: destinations.id }),
  ])
  return rows.length > 0
}
