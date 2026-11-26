import { and, desc, eq } from 'drizzle-orm'
import { apiKeys } from '../tenancy-schema'
import type { KitRepoDb } from './db-type'

type Db = KitRepoDb

export async function insertApiKey(
  db: Db,
  row: {
    id: string
    keyHash: string
    keyPrefix: string
    subject: string
    organizationId: string
    scopes: string
    name?: string | null
    createdAt: number
    expiresAt?: number | null
  },
) {
  await db
    .insert(apiKeys)
    .values({
      id: row.id,
      keyHash: row.keyHash,
      keyPrefix: row.keyPrefix,
      subject: row.subject,
      organizationId: row.organizationId,
      scopes: row.scopes,
      name: row.name ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt ?? null,
    })
    .run()
}

const apiKeyPublicColumns = {
  id: apiKeys.id,
  subject: apiKeys.subject,
  keyPrefix: apiKeys.keyPrefix,
  organizationId: apiKeys.organizationId,
  scopes: apiKeys.scopes,
  name: apiKeys.name,
  createdAt: apiKeys.createdAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
}

/** Session path: all API key metadata for subject (never returns keyHash). No org filter. */
export async function listApiKeysForSubject(db: Db, subject: string) {
  return db
    .select(apiKeyPublicColumns)
    .from(apiKeys)
    .where(eq(apiKeys.subject, subject))
    .orderBy(desc(apiKeys.createdAt))
    .all()
}

/**
 * D11 scoped list: keys for subject within one organization.
 * Filters on the exact `organizationId` received — never a normalized copy — so the value the
 * caller checked is the value queried. Empty, or leading/trailing whitespace, is a programming
 * error here: the HTTP route owns normalization or refusal before the call, and missing-org → `[]`
 * (`GET /api/keys` short-circuits).
 */
export async function listApiKeysForOrg(db: Db, subject: string, organizationId: string) {
  if (!organizationId || organizationId !== organizationId.trim()) {
    throw new Error(
      'listApiKeysForOrg: organizationId must be non-empty, without leading or trailing whitespace',
    )
  }
  return db
    .select(apiKeyPublicColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.subject, subject), eq(apiKeys.organizationId, organizationId)))
    .orderBy(desc(apiKeys.createdAt))
    .all()
}

/** Soft-revoke. Returns true if a row was updated. */
export async function revokeApiKey(db: Db, id: string, subject: string): Promise<boolean> {
  const rows = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.subject, subject)))
    .all()
  const row = rows[0]
  if (!row) return false
  if (row.revokedAt != null) return true
  await db
    .update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.subject, subject)))
    .run()
  return true
}
