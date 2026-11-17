import type { ImpersonationRolePermission } from '@kit/api-client/me'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@kit/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiErrorToMessage, apiFetch } from '../../lib/api'
import { hasPlatformRole, meQueryKey, useMe } from '../../lib/auth'
import { useLocale } from '../../lib/locale'

type PermissionsResponse = { permissions: ImpersonationRolePermission[]; requestId: string }
const queryKey = ['admin-impersonation-permissions'] as const

function PermissionRow({ permission }: { permission: ImpersonationRolePermission }) {
  const { m } = useLocale()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<{
    base: { read: boolean; write: boolean }
    values: { read: boolean; write: boolean }
    conflicted: boolean
  } | null>(null)
  const values = draft?.values ?? permission
  const baseChanged =
    draft !== null && (draft.base.read !== permission.read || draft.base.write !== permission.write)
  const conflict = baseChanged || (draft?.conflicted ?? false)
  useEffect(() => {
    if (baseChanged) {
      setDraft((current) =>
        current && !current.conflicted ? { ...current, conflicted: true } : current,
      )
    }
  }, [baseChanged])
  function edit(field: 'read' | 'write', value: boolean) {
    const base = draft?.base ?? { read: permission.read, write: permission.write }
    const next = { read: values.read, write: values.write, [field]: value }
    setDraft(
      !conflict && next.read === base.read && next.write === base.write
        ? null
        : { base, values: next, conflicted: conflict },
    )
  }
  const save = useMutation({
    mutationFn: (payload: ImpersonationRolePermission) =>
      apiFetch<PermissionsResponse>('/api/admin/impersonation/permissions', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey, exact: true }, { revert: false })
      const query = qc.getQueryCache().find({ queryKey, exact: true })
      return { query, updates: query?.state.dataUpdateCount }
    },
    onSuccess: async (data, _payload, context) => {
      const query = qc.getQueryCache().find({ queryKey, exact: true })
      if (query && query === context?.query) {
        await qc.cancelQueries({ queryKey, exact: true }, { revert: false })
        // The response covers every role; a newer cache write owns that whole snapshot.
        if (qc.getQueryCache().find({ queryKey, exact: true }) !== query) return
        if (query.state.dataUpdateCount === context.updates) {
          qc.setQueryData(queryKey, data)
          setDraft(null)
        } else {
          await qc.invalidateQueries({ queryKey, exact: true })
        }
      }
      await qc.invalidateQueries({ queryKey: meQueryKey })
      toast.success(m.impersonationSaved)
    },
    onError: (error) => toast.error(m.error, { description: apiErrorToMessage(error, m) }),
  })
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border p-3">
      <span className="min-w-28 font-medium">{permission.role}</span>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={values.read}
          onChange={(e) => edit('read', e.target.checked)}
          disabled={save.isPending}
        />
        {m.impersonationRead}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={values.write}
          onChange={(e) => edit('write', e.target.checked)}
          disabled={save.isPending}
        />
        {m.impersonationWrite}
      </label>
      <Button
        type="button"
        size="sm"
        disabled={save.isPending || draft === null || conflict}
        onClick={() =>
          save.mutate({ role: permission.role, read: values.read, write: values.write })
        }
      >
        {m.impersonationSave}
      </Button>
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
          <span>{m.impersonationConflict}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={save.isPending}
            onClick={() => setDraft(null)}
          >
            {m.impersonationReload}
          </Button>
        </div>
      )}
    </div>
  )
}

export function ImpersonationPermissionsCard() {
  const { m } = useLocale()
  const me = useMe()
  const enabled = hasPlatformRole(me.data, 'super_admin') && !me.data?.impersonation
  const permissions = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      apiFetch<PermissionsResponse>('/api/admin/impersonation/permissions', { signal }),
    enabled,
  })
  if (!enabled) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.impersonationPermissionsTitle}</CardTitle>
        <CardDescription>{m.impersonationPermissionsDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {permissions.isLoading ? (
          <p>{m.loading}</p>
        ) : permissions.isError ? (
          <div className="space-y-2">
            <p className="text-destructive">{apiErrorToMessage(permissions.error, m)}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void permissions.refetch()}
            >
              {m.retry}
            </Button>
          </div>
        ) : (
          permissions.data?.permissions.map((permission) => (
            <PermissionRow key={permission.role} permission={permission} />
          ))
        )}
      </CardContent>
    </Card>
  )
}
