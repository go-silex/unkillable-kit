import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@kit/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiErrorToMessage, apiFetch } from '../lib/api'
import { fetchMe, isUnauthorized, meQueryKey, useMe } from '../lib/auth'
import { parseInvitationId } from '../lib/invitation-id'
import { useLocale } from '../lib/locale'

function inviteLoginNext(invitationId: string): string {
  return `/invite/accept?invitationId=${encodeURIComponent(invitationId)}`
}

export function InviteAcceptPage() {
  const search = useSearch({ from: '/invite/accept' })
  const invitationId = parseInvitationId(search.invitationId) ?? ''
  return <Invitation invitationId={invitationId} key={invitationId} />
}

function Invitation({ invitationId }: { invitationId: string }) {
  const { m } = useLocale()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const [phase, setPhase] = useState<'ready' | 'refreshing' | 'recovery'>('ready')
  const active = useRef(false)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  async function refreshProfile() {
    setPhase('refreshing')
    try {
      await queryClient.cancelQueries({ queryKey: meQueryKey, exact: true })
      if (!active.current) return
      let receipt: AbortSignal | undefined
      await queryClient.fetchQuery({
        queryKey: meQueryKey,
        queryFn: async (context) => {
          const signal = context.signal
          const profile = await fetchMe(context)
          if (!signal.aborted) receipt = signal
          return profile
        },
        staleTime: 0,
        retry: false,
      })
      // A reverted cancellation may fulfill fetchQuery with the previous cache.
      const completed = receipt as AbortSignal | undefined
      if (!completed || completed.aborted) throw new Error('Profile refresh was cancelled')
      if (active.current) await navigate({ to: '/app' })
    } catch {
      if (active.current) setPhase('recovery')
    }
  }

  useEffect(() => {
    if (phase !== 'ready' || me.isLoading || !invitationId) return
    if (isUnauthorized(me.error) || !(me.data || me.isError)) {
      void navigate({
        to: '/login',
        search: { next: inviteLoginNext(invitationId) },
      })
    }
  }, [phase, me.isLoading, me.error, me.data, me.isError, navigate, invitationId])

  const accept = useMutation({
    mutationFn: () =>
      apiFetch<{ org: { name: string }; membership: { role: string } }>(
        `/api/invitations/${encodeURIComponent(invitationId)}/accept`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: async (data) => {
      if (!active.current) return
      toast.success(m.inviteAccepted, { description: data.org.name })
      await refreshProfile()
    },
    onError: (e) => {
      if (active.current) toast.error(m.error, { description: apiErrorToMessage(e, m) })
    },
  })

  if (!invitationId) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{m.inviteAcceptTitle}</CardTitle>
            <CardDescription>{m.inviteAcceptMissing}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button render={<Link to="/app" />}>{m.navAppHome}</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (phase !== 'ready') {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{m.inviteAccepted}</CardTitle>
            <CardDescription>
              {phase === 'refreshing' ? m.inviteRefreshing : m.inviteRefreshFailed}
            </CardDescription>
          </CardHeader>
          {phase === 'recovery' && (
            <CardContent>
              <Button type="button" onClick={() => void refreshProfile()}>
                {m.retry}
              </Button>
            </CardContent>
          )}
        </Card>
      </div>
    )
  }

  if (me.isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
        {m.loading}
      </div>
    )
  }

  if (me.isError && !isUnauthorized(me.error)) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{m.error}</CardTitle>
            <CardDescription>{m.loadFailed}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{apiErrorToMessage(me.error, m)}</p>
            <Button type="button" variant="secondary" onClick={() => void me.refetch()}>
              {m.retry}
            </Button>
            <Button
              type="button"
              variant="outline"
              render={<Link to="/login" search={{ next: inviteLoginNext(invitationId) }} />}
            >
              {m.login}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!me.data) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
        {m.loading}
      </div>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{m.inviteAcceptTitle}</CardTitle>
          <CardDescription>
            {m.inviteAcceptDesc} · {me.data.email ?? me.data.subject}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {m.inviteAcceptSubmit}
          </Button>
          <Button type="button" variant="outline" nativeButton={false} render={<Link to="/app" />}>
            {m.navAppHome}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
