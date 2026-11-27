import { decodeListCursor, encodeListCursor } from '@kit/core'
import type { ListPage, ListQuery } from '@kit/types'
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import * as z from 'zod'
import { kitNotifications as n } from '../drizzle-schema'
import type { Json } from '../types'
import { lifecycleStatement } from './admit-sql'
import type { Db, InboxScope, NotificationRow } from './types'
import {
  epochMsSchema,
  identitySchema,
  listQuerySchema,
  parseRepositoryInput,
  rowIdSchema,
} from './validation'

const scopeSchema = z.strictObject({
  orgId: identitySchema,
  userId: identitySchema,
  readableModuleIds: z.array(identitySchema),
})
const cursorSchema = z.strictObject({ createdAt: epochMsSchema, id: rowIdSchema })
const cursorKeysSchema = z.array(z.enum(['createdAt', 'id'])).length(2)
const querySchema = listQuerySchema.extend({ unreadOnly: z.boolean() })
const readSchema = z.strictObject({ id: rowIdSchema.optional(), now: epochMsSchema })
const selectionSchema = z.strictObject({
  sql: z.string().refine((value) => value.trim().length > 0),
  params: z.array(z.unknown()),
})
const dialect = new SQLiteSyncDialect()

export type InboxReadSelection = Readonly<{
  sql: string
  params: readonly unknown[]
}>

function visible(scope: InboxScope) {
  return and(
    eq(n.orgId, scope.orgId),
    eq(n.userId, scope.userId),
    or(
      isNull(n.moduleId),
      sql`${n.moduleId} IN (SELECT value FROM json_each(${JSON.stringify(scope.readableModuleIds)}))`,
    ),
  )
}
export function inboxCursor(cursor: string) {
  const decoded = decodeListCursor(cursor)
  parseRepositoryInput(cursorKeysSchema, Object.keys(decoded))
  return parseRepositoryInput(cursorSchema, decoded)
}
export async function listInbox(
  db: Db,
  inputScope: InboxScope,
  inputQuery: ListQuery & { unreadOnly: boolean },
): Promise<ListPage<NotificationRow>> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const query = parseRepositoryInput(querySchema, inputQuery)
  const cursor = query.cursor ? inboxCursor(query.cursor) : null
  const limit = query.limit ?? 50
  const rows = await db
    .select()
    .from(n)
    .where(
      and(
        visible(scope),
        query.unreadOnly ? and(isNull(n.readAt), isNull(n.resolvedAt)) : undefined,
        cursor
          ? or(
              lt(n.createdAt, cursor.createdAt),
              and(eq(n.createdAt, cursor.createdAt), lt(n.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(n.createdAt), desc(n.id))
    .limit(limit + 1)
  const items = rows
    .slice(0, limit)
    .map(({ sourceKind, sourceId, paramsJson, typeKey, ...row }) => ({
      ...row,
      type: typeKey,
      source: { kind: sourceKind, id: sourceId },
      params: JSON.parse(paramsJson) as Json,
    }))
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeListCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  }
}
export async function countUnread(db: Db, inputScope: InboxScope): Promise<number> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(n)
    .where(and(visible(scope), isNull(n.readAt), isNull(n.resolvedAt)))
  return rows[0]?.count ?? 0
}
export async function hasInboxNotification(
  db: Db,
  inputScope: InboxScope,
  inputId: string,
): Promise<boolean> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const id = parseRepositoryInput(rowIdSchema, inputId)
  const rows = await db
    .select({ id: n.id })
    .from(n)
    .where(and(visible(scope), eq(n.id, id)))
    .limit(1)
  return rows.length > 0
}
export async function markRead(
  db: Db,
  inputScope: InboxScope,
  input: { id?: string; now: number },
  selection?: InboxReadSelection,
): Promise<number> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const data = parseRepositoryInput(readSchema, input)
  const restriction =
    selection === undefined ? undefined : parseRepositoryInput(selectionSchema, selection)
  const predicate = dialect.sqlToQuery(
    and(visible(scope), isNull(n.readAt), data.id ? eq(n.id, data.id) : undefined)!,
  )
  const query = [
    'UPDATE kit_notifications SET read_at=? WHERE (',
    predicate.sql,
    ')',
    restriction ? ' AND id IN (' : '',
    restriction?.sql ?? '',
    restriction ? '\n)' : '',
    ' RETURNING id',
  ].join('')
  const result = (await lifecycleStatement(db, query, [
    data.now,
    ...predicate.params,
    ...(restriction?.params ?? []),
  ]).all()) as { results: unknown[] }
  return result.results.length
}
