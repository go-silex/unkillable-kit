/**
 * `/api/me` + `POST /api/orgs` response contract — hand-written parse-on-read
 * schemas shared by every kit client and pinned by the Worker's contract test.
 *
 * Lives here (not in an app) so both sides of the wire depend on one module:
 * the SPA parses reads with it, `example-api` asserts its own 200/201 bodies
 * against it. Cache/transport concerns (TanStack query keys, `apiFetch`) stay
 * in the app. Not generated from OpenAPI — see README "Non-goals".
 *
 * Reached via the `@kit/api-client/me` subpath, never the barrel: Worker-typed
 * consumers (Workers runtime types from `wrangler types`, no DOM lib) must not drag `index.ts`,
 * whose `fetch` transport needs the DOM `RequestCredentials`/`credentials`
 * surface, into their program. Keep this module zod-only.
 */
import { z } from 'zod'

/** Descriptive org fields match the Worker DTO (`z.string()`); gate-critical fields stay enum. */
export const meOrgSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  kind: z.string().min(1),
  status: z.string().min(1),
  /** System keys or org custom role key. */
  role: z.string().min(1),
})

export const impersonationModeSchema = z.enum(['read', 'write'])

const impersonationUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
})

export const impersonationPermissionsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
})

export const impersonationRolePermissionSchema = impersonationPermissionsSchema.extend({
  role: z.enum(['staff', 'super_admin']),
})

export const impersonationInfoSchema = z.object({
  id: z.string().min(1),
  mode: impersonationModeSchema,
  organizationId: z.string().min(1),
  actor: impersonationUserSchema,
  subject: impersonationUserSchema,
  startedAt: z.number().int().nonnegative(),
  active: z.boolean(),
})

export type ImpersonationMode = z.infer<typeof impersonationModeSchema>
export type ImpersonationPermissions = z.infer<typeof impersonationPermissionsSchema>
export type ImpersonationRolePermission = z.infer<typeof impersonationRolePermissionSchema>
export type ImpersonationInfo = z.infer<typeof impersonationInfoSchema>

export const meResponseSchema = z.object({
  subject: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  authMethod: z.enum(['session', 'api_key']).optional(),
  platformRole: z.enum(['super_admin', 'staff']).nullable(),
  orgs: z.array(meOrgSchema),
  impersonation: impersonationInfoSchema.nullable(),
  impersonationPermissions: impersonationPermissionsSchema,
  requestId: z.string(),
})

export type MeOrg = z.infer<typeof meOrgSchema>
export type MeResponse = z.infer<typeof meResponseSchema>
export type PlatformRole = NonNullable<MeResponse['platformRole']>

export function parseMe(data: unknown): MeResponse {
  return meResponseSchema.parse(data)
}

/** POST /api/orgs 201 body — parse before any me-cache write. */
export const createOrgResponseSchema = z.object({
  org: meOrgSchema.extend({ bypass: z.boolean().optional() }),
  requestId: z.string(),
})

/** API key scopes are independent; none implies another. */
export type ApiKeyScope = 'read' | 'write' | 'admin'

export type MintApiKeyRequest = {
  name?: string
  organizationId?: string
  scopes: ApiKeyScope[]
}

export type ApiKeyMeta = {
  id: string
  subject: string
  keyPrefix: string
  organizationId: string
  name: string | null
  scopes: ApiKeyScope[]
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
}

export type ListApiKeysResponse = { keys: ApiKeyMeta[]; requestId: string }
export type MintApiKeyResponse = {
  id: string
  key: string
  keyPrefix: string
  organizationId: string
  requestId: string
}
