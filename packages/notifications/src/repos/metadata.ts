import { encodeListCursor } from '@kit/core'
import type { ListPage } from '@kit/types'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'
import * as z from 'zod'
import {
  kitNotifications as n,
  kitNotificationOrganizationDeliveries as o,
  kitNotificationDeliveries as u,
} from '../drizzle-schema'
import { inboxCursor } from './inbox'
import type { Db, DeliveryMetadata, DeliveryQuery } from './types'
import {
  channelKeySchema,
  identitySchema,
  listQuerySchema,
  parseRepositoryInput,
  typeKeySchema,
} from './validation'

const querySchema = listQuerySchema.extend({
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  channel: channelKeySchema.optional(),
  type: typeKeySchema.optional(),
  targetKind: z.enum(['user', 'organization']).optional(),
})
const scopeSchema = z.strictObject({ orgId: identitySchema })

async function list(
  db: Db,
  input: DeliveryQuery,
  orgId: string | null,
  global: boolean,
): Promise<ListPage<DeliveryMetadata & { orgId: string }>> {
  const query = parseRepositoryInput(querySchema, input)
  const cursor = query.cursor ? inboxCursor(query.cursor) : null
  const limit = query.limit ?? 50
  const users = db
    .select({
      id: u.id,
      orgId: u.orgId,
      targetKind: sql<string>`'user'`.as('target_kind'),
      userId: sql<string | null>`${n.userId}`.as('user_id'),
      destinationId: sql<string | null>`NULL`.as('destination_id'),
      type: n.typeKey,
      channel: u.channel,
      status: u.status,
      errorCode: u.errorCode,
      attemptCount: u.attemptCount,
      admissionStatus: u.admissionStatus,
      createdAt: u.createdAt,
      finishedAt: u.finishedAt,
    })
    .from(u)
    .innerJoin(n, and(eq(u.notificationId, n.id), eq(u.orgId, n.orgId)))
    .where(orgId === null ? undefined : eq(u.orgId, orgId))
  const organizations = db
    .select({
      id: o.id,
      orgId: o.orgId,
      targetKind: sql<string>`'organization'`.as('target_kind'),
      userId: sql<string | null>`NULL`.as('user_id'),
      destinationId: sql<string | null>`${o.destinationId}`.as('destination_id'),
      type: o.typeKey,
      channel: o.channel,
      status: o.status,
      errorCode: o.errorCode,
      attemptCount: o.attemptCount,
      admissionStatus: o.admissionStatus,
      createdAt: o.createdAt,
      finishedAt: o.finishedAt,
    })
    .from(o)
    .where(orgId === null ? undefined : eq(o.orgId, orgId))
  const combined = unionAll(users, organizations).as('deliveries')
  const rows = await db
    .select()
    .from(combined)
    .where(
      and(
        global ? eq(combined.status, 'failed') : undefined,
        query.status ? eq(combined.status, query.status) : undefined,
        query.channel ? eq(combined.channel, query.channel) : undefined,
        query.type ? eq(combined.type, query.type) : undefined,
        query.targetKind ? eq(combined.targetKind, query.targetKind) : undefined,
        cursor
          ? or(
              lt(combined.createdAt, cursor.createdAt),
              and(eq(combined.createdAt, cursor.createdAt), lt(combined.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(combined.createdAt), desc(combined.id))
    .limit(limit + 1)
  const items = rows.slice(0, limit) as (DeliveryMetadata & { orgId: string })[]
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeListCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  }
}
export async function listDeliveryMetadata(
  db: Db,
  inputScope: { orgId: string },
  query: DeliveryQuery,
): Promise<ListPage<DeliveryMetadata>> {
  const scope = parseRepositoryInput(scopeSchema, inputScope)
  const page = await list(db, query, scope.orgId, false)
  return { ...page, items: page.items.map(({ orgId: _orgId, ...item }) => item) }
}
export async function listDeploymentFailures(
  db: Db,
  query: DeliveryQuery,
): Promise<ListPage<DeliveryMetadata & { orgId: string }>> {
  return list(db, query, null, true)
}
