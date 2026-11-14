import {
  type ApiKeyScope,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  parseApiKeyScopes,
} from '@kit/auth'
import * as keysRepo from '@kit/auth/repos/keys'
import { AppError } from '@kit/core'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { schema } from '../db/schema'
import { DEMO_EMAIL, DEMO_EMAIL_B, DEMO_PASSWORD, DEMO_PASSWORD_B } from '../seed/demo-data'

type Db = DrizzleD1Database<typeof schema>

export async function mintApiKey(
  db: Db,
  subject: string,
  opts: {
    scopes: ApiKeyScope[]
    name?: string
    expiresAt?: number | null
    ttlMs?: number
    /**
     * ADR-0003 D11 — mandatory. Minting without an organization is refused.
     *
     * This was previously gated behind an opt-in `requireOrganization` flag, which only one
     * call site passed: any new route that forgot it minted a subject-global key, the exact
     * state D11 forbids. Fail-closed instead of opt-in, so the guarantee holds by construction
     * rather than by every caller remembering.
     */
    organizationId?: string | null
  },
): Promise<{ id: string; key: string; keyPrefix: string; organizationId: string }> {
  if (
    !Array.isArray(opts?.scopes) ||
    opts.scopes.length === 0 ||
    opts.scopes.some((scope) => scope !== 'read' && scope !== 'write' && scope !== 'admin')
  ) {
    throw AppError.fieldErrors('scopes must contain at least one valid scope', {
      scopes: ['At least one valid scope is required'],
    })
  }
  const organizationId = opts?.organizationId?.trim() || null
  if (!organizationId) {
    throw AppError.fieldErrors('organizationId is required to mint an API key', {
      organizationId: ['organizationId is required'],
    })
  }
  const { findMembership, findOrgById } = await import('@kit/auth/repos/orgs')
  const org = await findOrgById(db, organizationId)
  if (org?.status !== 'active') throw AppError.notFound('Organization not found')
  const membership = await findMembership(db, organizationId, subject)
  if (!membership) throw AppError.forbidden('Not a member of this organization')
  const key = generateApiKey()
  const keyHash = await hashApiKey(key)
  const keyPrefix = apiKeyPrefix(key)
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  const expiresAt =
    opts?.expiresAt !== undefined ? opts.expiresAt : opts?.ttlMs ? createdAt + opts.ttlMs : null
  await keysRepo.insertApiKey(db, {
    id,
    keyHash,
    keyPrefix,
    subject,
    organizationId,
    scopes: opts.scopes.join(','),
    name: opts?.name ?? null,
    createdAt,
    expiresAt,
  })
  return { id, key, keyPrefix, organizationId }
}

/** Session path: all keys for subject (no org filter). */
export async function listApiKeysForSubject(db: Db, subject: string) {
  const keys = await keysRepo.listApiKeysForSubject(db, subject)
  return keys.map((key) => ({ ...key, scopes: parseApiKeyScopes(key.scopes) }))
}

/**
 * D11 scoped list for api_key auth.
 * Requires non-empty `organizationId` (repo throws if blank). HTTP missing-org → `[]` is owned by
 * `GET /api/keys` short-circuit — do not call this when key org is absent.
 */
export async function listApiKeysForOrg(db: Db, subject: string, organizationId: string) {
  const keys = await keysRepo.listApiKeysForOrg(db, subject, organizationId)
  return keys.map((key) => ({ ...key, scopes: parseApiKeyScopes(key.scopes) }))
}

export async function revokeApiKey(db: Db, id: string, subject: string): Promise<void> {
  const ok = await keysRepo.revokeApiKey(db, id, subject)
  if (!ok) throw AppError.notFound('API key not found')
}

// `resolveAuth` was removed here: an exported dual-auth resolver with zero call sites that
// carried its own copy of the org/membership re-check. Two copies of one guard is the drift
// mechanism that produced the NULL-org hole in the first place — the surviving copy in
// `middleware/require-auth.ts` was fixed while this one still skipped the check for
// `organization_id IS NULL`. Deleted rather than patched, so the trap cannot come back.
// The supported path is `createRequireAuth` (`middleware/require-auth.ts`).

/** Helper for tests that need a BA SessionPort with mock getAuth. */
export { DEMO_EMAIL, DEMO_EMAIL_B, DEMO_PASSWORD, DEMO_PASSWORD_B }
