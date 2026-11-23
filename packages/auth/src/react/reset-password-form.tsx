import { Button, Field, FieldError, FieldGroup, FieldLabel, PasswordInput } from '@kit/ui'
import { useForm } from '@tanstack/react-form'
import type { ReactNode } from 'react'
import { AUTH_RESET_PASSWORD_PATH, resetPasswordSchema } from '../password-schemas'
import { type AuthFormFetch, type AuthFormNotify, silentNotify } from './notify'

export type ResetPasswordCopy = {
  errValidation: string
  showPasswordLabel: string
  hidePasswordLabel: string
  resetPasswordNew: string
  resetPasswordConfirm: string
  resetPasswordSubmit: string
  resetPasswordTooShort: string
  resetPasswordMismatch: string
  resetPasswordMissingToken: string
  resetPasswordSuccess: string
  error: string
}

export function ResetPasswordForm({
  fetch: authFetch,
  copy,
  token,
  notify = silentNotify,
  loginLink,
  onSuccess,
  fallbackError,
}: {
  fetch: AuthFormFetch
  copy: ResetPasswordCopy
  token: string
  notify?: AuthFormNotify
  loginLink?: ReactNode
  onSuccess?: () => void | Promise<void>
  fallbackError?: (err: unknown) => string
}) {
  const form = useForm({
    defaultValues: { password: '', confirm: '' },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = resetPasswordSchema.safeParse(value)
        if (parsed.success) return
        const flat = parsed.error.flatten().fieldErrors
        return {
          form: copy.errValidation,
          fields: {
            password: flat.password?.[0] ? copy.resetPasswordTooShort : undefined,
            confirm: flat.confirm?.[0] ? copy.resetPasswordMismatch : undefined,
          },
        }
      },
    },
    onSubmit: async ({ value }) => {
      if (!token) {
        notify.error(copy.error, copy.resetPasswordMissingToken)
        return
      }
      try {
        await authFetch(AUTH_RESET_PASSWORD_PATH, {
          method: 'POST',
          body: JSON.stringify({ newPassword: value.password, token }),
        })
        notify.success(copy.resetPasswordSuccess)
        await onSuccess?.()
      } catch (e) {
        notify.error(copy.error, fallbackError?.(e))
      }
    },
  })

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        <form.Field name="password">
          {(field) => {
            const err = field.state.meta.errors[0]
            const errId = `${field.name}-error`
            const invalid = Boolean(err)
            return (
              <Field>
                <FieldLabel htmlFor={field.name}>{copy.resetPasswordNew}</FieldLabel>
                <PasswordInput
                  id={field.name}
                  name={field.name}
                  showPasswordLabel={copy.showPasswordLabel}
                  hidePasswordLabel={copy.hidePasswordLabel}
                  autoComplete="new-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(ev) => field.handleChange(ev.target.value)}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errId : undefined}
                />
                {invalid ? <FieldError id={errId}>{String(err)}</FieldError> : null}
              </Field>
            )
          }}
        </form.Field>
        <form.Field name="confirm">
          {(field) => {
            const err = field.state.meta.errors[0]
            const errId = `${field.name}-error`
            const invalid = Boolean(err)
            return (
              <Field>
                <FieldLabel htmlFor={field.name}>{copy.resetPasswordConfirm}</FieldLabel>
                <PasswordInput
                  id={field.name}
                  name={field.name}
                  showPasswordLabel={copy.showPasswordLabel}
                  hidePasswordLabel={copy.hidePasswordLabel}
                  autoComplete="new-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(ev) => field.handleChange(ev.target.value)}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errId : undefined}
                />
                {invalid ? <FieldError id={errId}>{String(err)}</FieldError> : null}
              </Field>
            )
          }}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {copy.resetPasswordSubmit}
            </Button>
          )}
        </form.Subscribe>
        {loginLink}
      </FieldGroup>
    </form>
  )
}
