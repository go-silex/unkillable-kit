import { createOrgResponseSchema } from '@kit/api-client/me'
import { changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } from '@kit/auth'
import * as z from 'zod'

export { changePasswordSchema, createOrgResponseSchema, forgotPasswordSchema, resetPasswordSchema }

/** Shared Zod schemas for TanStack Form (stack contract). */
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

/** Public email sign-up — BA min password 8; confirm must match. */
export const signupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.string().email(),
    password: z.string().min(8).max(128),
    confirm: z.string().min(1),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'mismatch' })

/** Magic-link request — email only (B-magic go-silex/silex-boilerplate#59). */
export const magicLinkSchema = z.object({
  email: z.string().email(),
})

/** Profile display name only (email change out of scope). */
export const profileNameSchema = z.object({
  name: z.string().trim().min(1).max(80),
})

export const createNoteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
})

/** Task create dialog — aligns with kit task title/description ceilings. */
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000),
  visibility: z.enum(['internal', 'shared']),
})

/** Org create (org-switcher) — mirrors example-api POST /api/orgs. */
export const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().max(48).optional(),
})

/** Items create — aligns with example-api POST /api/items. */
export const createItemSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
})

/** Items edit — aligns with example-api PATCH /api/items/:id. */
export const updateItemSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(2000),
  active: z.boolean(),
})

/** Org invite — system invitable keys or custom role key. */
export const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.string().trim().min(1).max(48),
})

/** Custom org role create — aligns with example-api POST /api/orgs/:id/roles. */
export const createOrgRoleSchema = z.object({
  key: z.string().trim().min(1).max(48),
  name: z.string().trim().min(1).max(80),
})

/** Admin user create — email required; name optional; platform role enum. */
export const createAdminUserSchema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().max(120).optional(),
  platformRole: z.enum(['staff', 'super_admin']).nullable().optional(),
  orgId: z.string().trim().max(64).optional(),
  orgRole: z.string().trim().min(1).max(48).optional(),
})

export type CreateItemValues = z.infer<typeof createItemSchema>
export type CreateAdminUserValues = z.infer<typeof createAdminUserSchema>
