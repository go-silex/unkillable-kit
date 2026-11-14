import { and, eq, sql } from 'drizzle-orm'
import { baSession, baUser } from '../better-auth-schema'
import { auditEvents } from '../tenancy-schema'
import type { KitRepoDb } from './db-type'

export type AccountStateContext = {
  actorUserId: string
  organizationId: string
  targetUserId: string
  /** Mounting audit is explicit. An audit failure rolls back the state change. */
  audit?: { ip?: string; requestId?: string }
}

/** Missing users are inactive; database errors propagate and must be denied by callers. */
export async function isAccountActive(
  db: KitRepoDb,
  userId: string,
  userTable: typeof baUser = baUser,
): Promise<boolean> {
  const rows = await db
    .select({ disabled: userTable.disabled })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1)
  return rows.length === 1 && !rows[0]!.disabled
}

/** Membership is necessary, not authorization: callers must enforce their own permission policy. */
export async function setAccountEnabled(
  db: KitRepoDb,
  context: AccountStateContext & { enabled: boolean },
): Promise<boolean> {
  const { actorUserId, organizationId, targetUserId, enabled, audit } = context
  if (!(actorUserId && organizationId && targetUserId)) return false

  // The membership and live actor checks are part of the write, not a prior read.
  const permitted = sql`exists (select 1 from member where organization_id = ${organizationId} and user_id = ${actorUserId})
    and exists (select 1 from member where organization_id = ${organizationId} and user_id = ${targetUserId})
    and exists (select 1 from user as actor where actor.id = ${actorUserId} and actor.disabled = 0)`
  const update = db
    .update(baUser)
    .set({ disabled: !enabled })
    .where(and(eq(baUser.id, targetUserId), permitted))
    .returning({ id: baUser.id })
  const revoke = db
    .delete(baSession)
    .where(and(eq(baSession.userId, targetUserId), sql`changes() = 1`))
  if (!audit) {
    if (enabled) return (await update).length === 1
    const [rows] = await db.batch([update, revoke])
    return rows.length === 1
  }

  const event = db.insert(auditEvents).select(
    db
      .select({
        id: sql<string>`${crypto.randomUUID()}`.as('id'),
        createdAt: sql<number>`${Date.now()}`.as('created_at'),
        actorUserId: sql<string>`${actorUserId}`.as('actor_user_id'),
        action: sql<string>`${enabled ? 'account.enabled' : 'account.disabled'}`.as('action'),
        targetType: sql<string>`'user'`.as('target_type'),
        targetId: baUser.id,
        orgId: sql<string>`${organizationId}`.as('org_id'),
        ip: sql<string | null>`${audit.ip ?? null}`.as('ip'),
        metaJson: sql<
          string | null
        >`${audit.requestId ? JSON.stringify({ requestId: audit.requestId }) : null}`.as(
          'meta_json',
        ),
      })
      .from(baUser)
      .where(and(eq(baUser.id, targetUserId), sql`changes() = 1`)),
  )
  if (enabled) {
    const [rows] = await db.batch([update, event])
    return rows.length === 1
  }
  const [rows] = await db.batch([update, event, revoke])
  return rows.length === 1
}

export function enableAccount(db: KitRepoDb, context: AccountStateContext): Promise<boolean> {
  return setAccountEnabled(db, { ...context, enabled: true })
}

export function disableAccount(db: KitRepoDb, context: AccountStateContext): Promise<boolean> {
  return setAccountEnabled(db, { ...context, enabled: false })
}
