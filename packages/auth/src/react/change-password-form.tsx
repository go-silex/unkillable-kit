import { Button, Field, FieldError, FieldGroup, FieldLabel, PasswordInput } from '@kit/ui'
import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import { AUTH_CHANGE_PASSWORD_PATH, changePasswordSchema } from '../password-schemas'
import { changePasswordErrorMessage } from './errors'
import { type AuthFormFetch, type AuthFormNotify, silentNotify } from './notify'

export type ChangePasswordCopy = {
  errValidation: string
  showPasswordLabel: string
  hidePasswordLabel: string
  changePasswordCurrent: string
  changePasswordNew: string
  changePasswordConfirm: string
  changePasswordSubmit: string
  changePasswordSuccess: string
  changePasswordWrong: string
  changePasswordReauth: string
  changePasswordRevokeOthers: string
  changePasswordTooShort: string
  changePasswordMismatch: string
  changePasswordCurrentRequired: string
  errRateLimited: string
  loading: string
  error: string
}

export function ChangePasswordForm({
  fetch: authFetch,
  copy,
  notify = silentNotify,
  fallbackError = () => copy.error,
}: {
  fetch: AuthFormFetch
  copy: ChangePasswordCopy
  notify?: AuthFormNotify
  fallbackError?: (err: unknown) => string
}) {
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true)
  const form = useForm({
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = changePasswordSchema.safeParse(value)
        if (parsed.success) return
        const flat = parsed.error.flatten().fieldErrors
        return {
          form: copy.errValidation,
          fields: {
            currentPassword: flat.currentPassword?.[0]
              ? copy.changePasswordCurrentRequired
              : undefined,
            newPassword: flat.newPassword?.[0] ? copy.changePasswordTooShort : undefined,
            confirm: flat.confirm?.[0] ? copy.changePasswordMismatch : undefined,
          },
        }
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await authFetch(AUTH_CHANGE_PASSWORD_PATH, {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: value.currentPassword,
            newPassword: value.newPassword,
            revokeOtherSessions,
          }),
        })
        notify.success(copy.changePasswordSuccess)
        formApi.reset()
        setRevokeOtherSessions(true)
      } catch (e) {
        notify.error(copy.error, changePasswordErrorMessage(e, copy, fallbackError))
        formApi.setFieldValue('newPassword', '')
        formApi.setFieldValue('confirm', '')
      }
    },
  })

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        <form.Field name="currentPassword">
          {(field) => {
            const err = field.state.meta.errors[0]
            const invalid = Boolean(err)
            const errId = `${field.name}-error`
            return (
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={field.name}>{copy.changePasswordCurrent}</FieldLabel>
                <PasswordInput
                  id={field.name}
                  name={field.name}
                  showPasswordLabel={copy.showPasswordLabel}
                  hidePasswordLabel={copy.hidePasswordLabel}
                  autoComplete="current-password"
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
        <form.Field name="newPassword">
          {(field) => {
            const err = field.state.meta.errors[0]
            const invalid = Boolean(err)
            const errId = `${field.name}-error`
            return (
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={field.name}>{copy.changePasswordNew}</FieldLabel>
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
            const invalid = Boolean(err)
            const errId = `${field.name}-error`
            return (
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={field.name}>{copy.changePasswordConfirm}</FieldLabel>
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
      </FieldGroup>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={revokeOtherSessions}
          onChange={(ev) => setRevokeOtherSessions(ev.target.checked)}
        />
        <span>{copy.changePasswordRevokeOthers}</span>
      </label>
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting ? copy.loading : copy.changePasswordSubmit}
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}
