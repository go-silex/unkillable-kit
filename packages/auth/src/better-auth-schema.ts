/**
 * Better Auth Drizzle SQLite/D1 tables (ADR-0008 D6).
 *
 * SQL identity is catalog `id` + `kitSha256` (`config/kit/kit-schema-modules.json`).
 * `apps/example-api/migrations/*` is the dogfood wrangler journal, not a clone template.
 * This module is the Drizzle companion — products import `@kit/auth/schema`.
 */
import { relations, sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const baUser = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

export const baSession = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => baUser.id, { onDelete: 'cascade' }),
    /** BA organization plugin — active org UX default (not sole authz authority). */
    activeOrganizationId: text('active_organization_id'),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
)

export const baOrganization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  /** ADR-0003 additionalFields */
  kind: text('kind').notNull().default('client'),
  status: text('status').notNull().default('active'),
})

export const baMember = sqliteTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => baOrganization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => baUser.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index('member_organizationId_idx').on(table.organizationId),
    index('member_userId_idx').on(table.userId),
  ],
)

export const baInvitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => baOrganization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => baUser.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('invitation_organizationId_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ],
)

export const baAccount = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    issuer: text('issuer').notNull().default('local:credential'),
    userId: text('user_id')
      .notNull()
      .references(() => baUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('account_userId_idx').on(table.userId),
    uniqueIndex('account_issuer_accountId_uidx').on(table.issuer, table.accountId),
  ],
)

export const baVerification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

const betterAuthTables = {
  user: baUser,
  session: baSession,
  account: baAccount,
  verification: baVerification,
  organization: baOrganization,
  member: baMember,
  invitation: baInvitation,
}

/** The Better Auth tables; custom schemas retain their own table identities. */
export type BetterAuthTables = typeof betterAuthTables

/** Build relation metadata against the exact tables passed to Drizzle and the adapter. */
export function withBetterAuthRelations<T extends BetterAuthTables>(tables: T) {
  return {
    ...tables,
    userRelations: relations(tables.user, ({ many }) => ({
      accounts: many(tables.account),
      sessions: many(tables.session),
      members: many(tables.member),
      invitations: many(tables.invitation),
    })),
    sessionRelations: relations(tables.session, ({ one }) => ({
      user: one(tables.user, { fields: [tables.session.userId], references: [tables.user.id] }),
    })),
    accountRelations: relations(tables.account, ({ one }) => ({
      user: one(tables.user, { fields: [tables.account.userId], references: [tables.user.id] }),
    })),
    organizationRelations: relations(tables.organization, ({ many }) => ({
      members: many(tables.member),
      invitations: many(tables.invitation),
    })),
    memberRelations: relations(tables.member, ({ one }) => ({
      user: one(tables.user, { fields: [tables.member.userId], references: [tables.user.id] }),
      organization: one(tables.organization, {
        fields: [tables.member.organizationId],
        references: [tables.organization.id],
      }),
    })),
    invitationRelations: relations(tables.invitation, ({ one }) => ({
      user: one(tables.user, {
        fields: [tables.invitation.inviterId],
        references: [tables.user.id],
      }),
      organization: one(tables.organization, {
        fields: [tables.invitation.organizationId],
        references: [tables.organization.id],
      }),
    })),
  }
}

export const betterAuthDrizzleSchema = withBetterAuthRelations(betterAuthTables)

export {
  impersonationDrizzleSchema,
  impersonationRolePermissions,
  impersonationSessions,
} from './impersonation-schema'
export {
  apiKeys,
  auditEvents,
  kitModules,
  organizationModules,
  organizationRoleModuleGrants,
  organizationRoles,
  platformModules,
  rateLimitBuckets,
  tenancyDrizzleSchema,
  userPlatformRoles,
} from './tenancy-schema'

import { impersonationDrizzleSchema } from './impersonation-schema'

import { tenancyDrizzleSchema } from './tenancy-schema'

/** Better Auth + kit tenancy/RBAC tables for Drizzle compose. */
export const kitAuthSchema = {
  ...betterAuthDrizzleSchema,
  ...tenancyDrizzleSchema,
  ...impersonationDrizzleSchema,
}
