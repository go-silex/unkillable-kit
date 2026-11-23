import {
  Button,
  cn,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  LocaleSwitcher,
  PasswordInput,
} from '@kit/ui'
import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { GalleryVerticalEnd } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { profileErrorMessage, signupErrorMessage } from '../lib/account-errors'
import { apiFetch } from '../lib/api'
import {
  dropPrincipalCache,
  fetchMe,
  isUnauthorized,
  type MeResponse,
  meQueryKey,
  postAuthTarget,
  useMe,
} from '../lib/auth'
import { useLocale } from '../lib/locale'
import { signupSchema } from '../lib/schemas'

/**
 * Public email sign-up — mounted only when `/health.allowPublicSignup` is true
 * (`ALLOW_PUBLIC_SIGNUP=true`). Route `beforeLoad` redirects to `/login` otherwise.
 */
export function SignupPage() {
  const { m, locale, setLocale, locales } = useLocale()
  const navigate = useNavigate()
  const search = useSearch({ from: '/sign-up' })
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const me = useMe()

  useEffect(() => {
    if (!me.data) return
    const target = postAuthTarget(me.data, search.next)
    void navigate({ href: target, replace: true })
  }, [me.data, navigate, search.next])

  const form = useForm({
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirm: '',
    },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = signupSchema.safeParse(value)
        if (parsed.success) return
        const flat = parsed.error.flatten().fieldErrors
        return {
          form: m.errValidation,
          fields: {
            name: flat.name?.[0] ? m.signUpNameRequired : undefined,
            email: flat.email?.[0] ? m.errEmailInvalid : undefined,
            password: flat.password?.[0] ? m.resetPasswordTooShort : undefined,
            confirm: flat.confirm?.[0] ? m.resetPasswordMismatch : undefined,
          },
        }
      },
    },
    onSubmit: async ({ value }) => {
      setError(null)
      const parsed = signupSchema.safeParse(value)
      if (!parsed.success) return
      const { email, password, name } = parsed.data
      try {
        await apiFetch('/api/auth/sign-up/email', {
          method: 'POST',
          body: JSON.stringify({ email, password, name }),
        })
      } catch (e) {
        const msg = signupErrorMessage(e, m)
        setError(msg)
        toast.error(m.error, { description: msg })
        return
      }
      dropPrincipalCache(qc)
      try {
        let meAfter: MeResponse
        try {
          meAfter = await qc.fetchQuery({
            queryKey: meQueryKey,
            queryFn: fetchMe,
          })
        } catch (e) {
          if (!isUnauthorized(e)) throw e
          await apiFetch('/api/auth/sign-in/email', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          })
          dropPrincipalCache(qc)
          meAfter = await qc.fetchQuery({
            queryKey: meQueryKey,
            queryFn: fetchMe,
          })
        }
        toast.success(m.signUp, { description: email })
        const target = postAuthTarget(meAfter, search.next)
        await navigate({ href: target, replace: true })
      } catch (e) {
        const msg = profileErrorMessage(e, m)
        setError(msg)
        toast.error(m.error, { description: msg })
      }
    },
  })

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <LocaleSwitcher
        className="absolute top-4 right-4"
        locales={locales}
        value={locale}
        onChange={setLocale}
      />

      <div className={cn('flex w-full max-w-sm flex-col gap-6')}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <GalleryVerticalEnd className="size-5" aria-hidden />
          </div>
          <h1 className="text-xl font-bold">{m.signUpTitle}</h1>
          <p className="text-sm text-muted-foreground">{m.signUpDesc}</p>
        </div>

        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field name="name">
              {(field) => {
                const err = field.state.meta.errors[0]
                const errId = `${field.name}-error`
                const invalid = Boolean(err)
                return (
                  <Field>
                    <FieldLabel htmlFor={field.name}>{m.signUpName}</FieldLabel>
                    <Input
                      id={field.name}
                      type="text"
                      autoComplete="name"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? errId : undefined}
                    />
                    {invalid ? <FieldError id={errId}>{String(err)}</FieldError> : null}
                  </Field>
                )
              }}
            </form.Field>
            <form.Field name="email">
              {(field) => {
                const err = field.state.meta.errors[0]
                const errId = `${field.name}-error`
                const invalid = Boolean(err)
                return (
                  <Field>
                    <FieldLabel htmlFor={field.name}>{m.email}</FieldLabel>
                    <Input
                      id={field.name}
                      type="email"
                      autoComplete="email"
                      placeholder="m@example.com"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? errId : undefined}
                    />
                    {invalid ? <FieldError id={errId}>{String(err)}</FieldError> : null}
                  </Field>
                )
              }}
            </form.Field>
            <form.Field name="password">
              {(field) => {
                const err = field.state.meta.errors[0]
                const errId = `${field.name}-error`
                const invalid = Boolean(err)
                return (
                  <Field>
                    <FieldLabel htmlFor={field.name}>{m.password}</FieldLabel>
                    <PasswordInput
                      id={field.name}
                      name={field.name}
                      showPasswordLabel={m.showPasswordLabel}
                      hidePasswordLabel={m.hidePasswordLabel}
                      autoComplete="new-password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
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
                    <FieldLabel htmlFor={field.name}>{m.resetPasswordConfirm}</FieldLabel>
                    <PasswordInput
                      id={field.name}
                      name={field.name}
                      showPasswordLabel={m.showPasswordLabel}
                      hidePasswordLabel={m.hidePasswordLabel}
                      autoComplete="new-password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? errId : undefined}
                    />
                    {invalid ? <FieldError id={errId}>{String(err)}</FieldError> : null}
                  </Field>
                )
              }}
            </form.Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {m.signUpSubmit}
                </Button>
              )}
            </form.Subscribe>
          </FieldGroup>
        </form>

        <p className="text-center text-sm">
          <Link
            to="/login"
            search={search.next ? { next: search.next } : {}}
            className="underline-offset-4 hover:underline"
          >
            {m.signUpHasAccount}
          </Link>
        </p>

        <p className="text-center text-xs text-balance text-muted-foreground">{m.loginLegal}</p>
      </div>
    </div>
  )
}
