/**
 * Kit tenancy / RBAC / security tables (ADR-0003, B-auth-harden).
 * SQL identity: catalog id + hash. Dogfood journal: `apps/example-api/migrations/*`.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  /** Lookup index — first 12 chars of plaintext sk_ (never the full key). */
  keyPrefix: text('key_prefix').notNull().unique(),
  subject: text('subject').notNull(),
  /** ADR-0003 D11 + INV-04 — multi-tenant keys are org-bound (enforced NOT NULL after 0015 cleanup/revoke). */
  organizationId: text('organization_id').notNull(),
  scopes: text('scopes').notNull().default(''),
  name: text('name'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'number' }),
  revokedAt: integer('revoked_at', { mode: 'number' }),
})

/** Feature modules toggled at runtime (not .env). Legacy — prefer platform_modules. */
export const kitModules = sqliteTable('kit_modules', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** JSON integration settings (e.g. optional module config JSON). */
  configJson: text('config_json'),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

/** ADR-0003 platform plane roles (not BA user additionalFields). */
export const userPlatformRoles = sqliteTable('user_platform_roles', {
  userId: text('user_id').primaryKey(),
  role: text('role').notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

/** ADR-0003 level-1 module catalogue. */
export const platformModules = sqliteTable('platform_modules', {
  moduleId: text('module_id').primaryKey(),
  available: integer('available', { mode: 'boolean' }).notNull().default(false),
  configJson: text('config_json'),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

/** ADR-0003 level-2 per-organization module enablement. */
export const organizationModules = sqliteTable(
  'organization_modules',
  {
    organizationId: text('organization_id').notNull(),
    moduleId: text('module_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    configJson: text('config_json'),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.moduleId] })],
)

/** ADR-0003 Phase B — system + custom roles per organization. */
export const organizationRoles = sqliteTable('organization_roles', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
})

/** ADR-0003 Phase B — per-role module grants (write | read | disabled). */
export const organizationRoleModuleGrants = sqliteTable(
  'organization_role_module_grants',
  {
    roleId: text('role_id').notNull(),
    moduleId: text('module_id').notNull(),
    access: text('access').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.moduleId] })],
)

/**
 * Durable fixed-window rate-limit counters (B-auth-harden go-silex/silex-boilerplate#61).
 * Shared across Workers isolates via D1 — not an in-memory Map.
 */
export const rateLimitBuckets = sqliteTable(
  'rate_limit_buckets',
  {
    bucketKey: text('bucket_key').notNull(),
    windowStartMs: integer('window_start_ms', { mode: 'number' }).notNull(),
    count: integer('count', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucketKey, t.windowStartMs] })],
)

/** Append-only security-relevant events (super_admin list API). */
export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  orgId: text('org_id'),
  ip: text('ip'),
  metaJson: text('meta_json'),
})

export const tenancyDrizzleSchema = {
  apiKeys,
  kitModules,
  userPlatformRoles,
  platformModules,
  organizationModules,
  organizationRoles,
  organizationRoleModuleGrants,
  rateLimitBuckets,
  auditEvents,
}
