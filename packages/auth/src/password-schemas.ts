import * as z from 'zod'

/** Public forgot-password request (enumeration-safe on the API). */
export const forgotPasswordSchema = z.object({
  email: z.string().email(),
})

/** BA default min password length is typically 8. */
export const resetPasswordSchema = z
  .object({
    password: z.string().min(8).max(128),
    confirm: z.string().min(1),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'mismatch' })

/** Authenticated change-password. Revoke-others checkbox is outside Zod. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
    confirm: z.string().min(1),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'mismatch' })

export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>

export const AUTH_REQUEST_PASSWORD_RESET_PATH = '/api/auth/request-password-reset'
export const AUTH_RESET_PASSWORD_PATH = '/api/auth/reset-password'
export const AUTH_CHANGE_PASSWORD_PATH = '/api/auth/change-password'
