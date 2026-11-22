import { ResetPasswordForm } from '@kit/auth/react'
import { Button, cn, LocaleSwitcher } from '@kit/ui'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { GalleryVerticalEnd } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiErrorToMessage, apiFetch, HttpError } from '../lib/api'
import { defaultHomePath, fetchMe } from '../lib/auth'
import { useLocale } from '../lib/locale'
import { safePostAuthPath } from '../lib/safe-return-path'

/**
 * Complete password reset with the token from the emailed link.
 * Token is captured into state then stripped from the URL (history/replace).
 * Form lives in `@kit/auth/react`; post-success navigation stays in the app.
 */
export function ResetPasswordPage() {
  const { m, locale, setLocale, locales } = useLocale()
  const navigate = useNavigate()
  const search = useSearch({ from: '/reset-password' })
  const stripped = useRef(false)
  const [token, setToken] = useState(() => search.token?.trim() ?? '')
  const [nextPath, setNextPath] = useState(() => safePostAuthPath(search.next) ?? '')
  const [linkError, setLinkError] = useState(() => search.error?.trim() || undefined)

  useEffect(() => {
    if (stripped.current) return
    const t = search.token?.trim() ?? ''
    const err = search.error?.trim()
    const next = safePostAuthPath(search.next)
    if (t && t !== token) setToken(t)
    if (next) setNextPath(next)
    if (err) setLinkError(err)
    if (search.token || search.error || search.next) {
      stripped.current = true
      void navigate({
        to: '/reset-password',
        search: { token: undefined, error: undefined, next: undefined },
        replace: true,
      })
    }
  }, [search.token, search.error, search.next, navigate, token])

  const afterReset = async () => {
    const preferred = safePostAuthPath(nextPath)
    if (preferred?.startsWith('/invite/accept')) {
      window.location.assign(preferred)
      return
    }
    try {
      const me = await fetchMe()
      const home = preferred === '/app' || preferred === '/admin' ? preferred : defaultHomePath(me)
      await navigate({ to: home })
    } catch {
      await navigate({ to: '/login' })
    }
  }

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
          <h1 className="text-xl font-bold">{m.resetPasswordTitle}</h1>
          <p className="text-sm text-muted-foreground">{m.resetPasswordDesc}</p>
        </div>

        {linkError || !token ? (
          <div className="flex flex-col gap-4 text-center">
            <p className="text-sm text-muted-foreground">
              {linkError ? m.resetPasswordInvalidLink : m.resetPasswordMissingToken}
            </p>
            <Button variant="outline" nativeButton={false} render={<Link to="/forgot-password" />}>
              {m.forgotPassword}
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link to="/login" />}>
              {m.backToLogin}
            </Button>
          </div>
        ) : (
          <ResetPasswordForm
            fetch={apiFetch}
            copy={m}
            token={token}
            fallbackError={(error) => {
              if (
                error instanceof HttpError &&
                error.status === 400 &&
                error.upstreamCode === 'INVALID_TOKEN'
              ) {
                setLinkError(error.upstreamCode)
                return m.resetPasswordInvalidLink
              }
              return apiErrorToMessage(error, m)
            }}
            notify={{
              success: (title, description) => toast.success(title, { description }),
              error: (title, description) => toast.error(title, { description }),
              message: (title, description) => toast.message(title, { description }),
            }}
            onSuccess={() => void afterReset()}
            loginLink={
              <Button
                variant="ghost"
                className="w-full"
                nativeButton={false}
                render={<Link to="/login" />}
              >
                {m.backToLogin}
              </Button>
            }
          />
        )}
      </div>
    </div>
  )
}
