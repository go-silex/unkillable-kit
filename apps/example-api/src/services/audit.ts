import * as auditRepo from '@kit/auth/repos/audit'
import {
  AppError,
  clampListLimit,
  decodeListCursor,
  isRepresentableEpochMs,
  takeListPage,
} from '@kit/core'
import type { KitDb } from '../lib/db-type'

const AUDIT_ACTIONS = [
  'user.created',
  'platform_role.set',
  'membership.add',
  'first_login',
  'invite.accept',
  'task.create',
  'task.update',
  'task.delete',
  'task.link_create',
  'task.link_delete',
  'notification.rule.set',
  'notification.rule.delete',
] as const

type AuditAction = (typeof AUDIT_ACTIONS)[number]

const DENY_KEY = /token|password|secret|authorization|cookie|rawbody/i
const URL_TOKEN_QUERY = /[?&](token|code|key|secret)=/i

/** Per-action allowlisted meta keys (no free-form dump). */
const META_ALLOW: Record<string, Record<string, true>> = {
  'user.created': { emailDomain: true },
  'platform_role.set': { role: true },
  'membership.add': { role: true },
  first_login: { method: true },
  'invite.accept': { invitationId: true },
  'task.create': { boardKey: true, stageId: true },
  'task.update': { boardKey: true, stageId: true },
  'task.delete': {},
  'task.link_create': { linkKind: true },
  'task.link_delete': { linkKind: true },
  'notification.rule.set': {
    selectorKind: true,
    selectorValue: true,
    channel: true,
    enabled: true,
    locked: true,
  },
  'notification.rule.delete': {
    selectorKind: true,
    selectorValue: true,
    channel: true,
    enabled: true,
    locked: true,
  },
}

function newAuditId(): string {
  return `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function isDeniedValue(v: unknown): boolean {
  if (typeof v !== 'string') return false
  if (URL_TOKEN_QUERY.test(v)) return true
  if (v.length > 200) return true
  return false
}

/** Sanitize meta: allowlist keys + denylist key names/values. */
export function sanitizeAuditMeta(
  action: string,
  meta?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const allow = META_ALLOW[action]
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (DENY_KEY.test(k)) continue
    if (allow && !Object.hasOwn(allow, k)) continue
    if (isDeniedValue(v)) continue
    if (v === undefined) continue
    out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export type AppendAuditInput = {
  action: AuditAction | string
  actorUserId?: string | null
  targetType?: string | null
  targetId?: string | null
  orgId?: string | null
  ip?: string | null
  meta?: Record<string, unknown> | null
  /** When set, included in failure logs (best-effort audit). */
  requestId?: string | null
}

/** Emit user.created + optional platform_role.set + membership.add (admin provision). */
export async function emitAdminUserProvisioned(
  db: KitDb,
  input: {
    actorUserId: string
    userId: string
    email: string
    platformRole?: string | null
    memberships: { organizationId: string; role: string }[]
    requestId?: string | null
  },
): Promise<void> {
  const emailDomain = input.email.includes('@') ? input.email.split('@')[1] : undefined
  const rid = input.requestId
  await appendAudit(db, {
    action: 'user.created',
    actorUserId: input.actorUserId,
    targetType: 'user',
    targetId: input.userId,
    meta: emailDomain ? { emailDomain } : undefined,
    requestId: rid,
  })
  if (input.platformRole) {
    await appendAudit(db, {
      action: 'platform_role.set',
      actorUserId: input.actorUserId,
      targetType: 'user',
      targetId: input.userId,
      meta: { role: input.platformRole },
      requestId: rid,
    })
  }
  for (const m of input.memberships) {
    await appendAudit(db, {
      action: 'membership.add',
      actorUserId: input.actorUserId,
      targetType: 'user',
      targetId: input.userId,
      orgId: m.organizationId,
      meta: { role: m.role },
      requestId: rid,
    })
  }
}

/**
 * Best-effort audit append. Domain callers must not roll back on failure.
 * Failures log `action` + `requestId` (when provided) and return false.
 */
export async function appendAudit(db: KitDb, input: AppendAuditInput): Promise<boolean> {
  const cleanMeta = sanitizeAuditMeta(input.action, input.meta)
  try {
    await auditRepo.insertAuditEvent(db, {
      id: newAuditId(),
      createdAt: Date.now(),
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      orgId: input.orgId,
      ip: input.ip,
      metaJson: cleanMeta ? JSON.stringify(cleanMeta) : null,
    })
    return true
  } catch (err) {
    const rid = input.requestId ?? 'unknown'
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'audit_append_failed',
        action: input.action,
        requestId: rid,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return false
  }
}

/** Idempotent first_login via unique index; best-effort. */
export async function tryFirstLogin(
  db: KitDb,
  opts: {
    userId: string
    actorUserId?: string | null
    ip?: string | null
    method?: string
    requestId?: string | null
  },
): Promise<void> {
  const meta = sanitizeAuditMeta('first_login', opts.method ? { method: opts.method } : null)
  try {
    await auditRepo.insertFirstLoginIfAbsent(db, {
      id: newAuditId(),
      createdAt: Date.now(),
      actorUserId: opts.actorUserId ?? opts.userId,
      targetId: opts.userId,
      ip: opts.ip,
      metaJson: meta ? JSON.stringify(meta) : null,
    })
  } catch (err) {
    const rid = opts.requestId ?? 'unknown'
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'audit_append_failed',
        action: 'first_login',
        requestId: rid,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

export type ListedAuditEvent = {
  id: string
  createdAt: number
  actorUserId: string | null
  action: string
  targetType?: string
  targetId?: string
  orgId?: string | null
  ip?: string | null
  meta?: Record<string, unknown>
}

function parseCreatedAtIdKeyset(cursor: string): { createdAt: number; id: string } {
  const decoded = decodeListCursor(cursor)
  const keys = Object.keys(decoded)
  if (keys.length !== 2 || !keys.includes('createdAt') || !keys.includes('id')) {
    throw AppError.validation('Invalid cursor')
  }
  const createdAt = decoded.createdAt
  const id = decoded.id
  if (typeof createdAt !== 'number' || !isRepresentableEpochMs(createdAt)) {
    throw AppError.validation('Invalid cursor')
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw AppError.validation('Invalid cursor')
  }
  return { createdAt, id }
}

export async function listRecentAuditEvents(
  db: KitDb,
  opts: { limit?: number; cursor?: string | null },
): Promise<{ items: ListedAuditEvent[]; nextCursor: string | null }> {
  const limit = clampListLimit(opts.limit)
  let cursorCreatedAt: number | undefined
  let cursorId: string | undefined
  if (opts.cursor) {
    const keyset = parseCreatedAtIdKeyset(opts.cursor)
    cursorCreatedAt = keyset.createdAt
    cursorId = keyset.id
  }

  const rows = await auditRepo.listAuditEvents(db, {
    limit: limit + 1,
    cursorCreatedAt,
    cursorId,
  })

  const page = takeListPage(rows, limit, (r) => ({
    createdAt: r.createdAt,
    id: r.id,
  }))

  const items: ListedAuditEvent[] = page.items.map((r) => {
    let meta: Record<string, unknown> | undefined
    if (r.metaJson) {
      try {
        meta = JSON.parse(r.metaJson) as Record<string, unknown>
      } catch {
        meta = undefined
      }
    }
    return {
      id: r.id,
      createdAt: r.createdAt,
      actorUserId: r.actorUserId,
      action: r.action,
      ...(r.targetType ? { targetType: r.targetType } : {}),
      ...(r.targetId ? { targetId: r.targetId } : {}),
      ...(r.orgId != null ? { orgId: r.orgId } : {}),
      ...(r.ip != null ? { ip: r.ip } : {}),
      ...(meta ? { meta } : {}),
    }
  })

  return { items, nextCursor: page.nextCursor }
}
