import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kit/ui'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiErrorToMessage } from '../lib/api'
import { useLocale } from '../lib/locale'
import {
  clearOptimisticGrantIfCurrent,
  mergeOptimisticGrant,
  type OrgRoleGrantInput,
  type OrgRolesQuery,
  orgRoleGrantKey,
  useCreateOrgRole,
  useDeleteOrgRole,
  usePatchOrgRoleGrant,
} from '../lib/org-members'
import { createOrgRoleSchema } from '../lib/schemas'

export function OrgRolesCard({ orgId, roles }: { orgId: string; roles: OrgRolesQuery }) {
  const { m } = useLocale()
  const [newRoleKey, setNewRoleKey] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [pendingDeleteRoleId, setPendingDeleteRoleId] = useState<string | null>(null)
  /** Optimistic grant access while PATCH is in flight — key `${roleId}:${moduleId}`. */
  const [optimisticAccess, setOptimisticAccess] = useState<Record<string, OrgRoleGrantInput>>({})

  const accessItems = useMemo(
    () =>
      [
        { value: 'write' as const, label: m.accessWrite },
        { value: 'read' as const, label: m.accessRead },
        { value: 'disabled' as const, label: m.accessDisabled },
      ] as const,
    [m.accessWrite, m.accessRead, m.accessDisabled],
  )

  const createRole = useCreateOrgRole(orgId)
  const patchGrant = usePatchOrgRoleGrant({
    onMutate: (input) => {
      setOptimisticAccess((prev) => mergeOptimisticGrant(prev, input))
    },
    onSuccess: (input) => {
      setOptimisticAccess((prev) => clearOptimisticGrantIfCurrent(prev, input))
    },
    onError: (e, input) => {
      setOptimisticAccess((prev) => clearOptimisticGrantIfCurrent(prev, input))
      toast.error(m.error, { description: apiErrorToMessage(e, m) })
    },
  })
  const deleteRole = useDeleteOrgRole(orgId)

  const pendingDeleteRole = (roles.data?.roles ?? []).find((r) => r.id === pendingDeleteRoleId)

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.orgRolesTitle}</CardTitle>
          <CardDescription>{m.orgRolesDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="role-key">{m.orgRoleKey}</Label>
              <Input
                id="role-key"
                value={newRoleKey}
                onChange={(e) => setNewRoleKey(e.target.value)}
                placeholder="lead"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-name">{m.orgRoleName}</Label>
              <Input
                id="role-name"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="Lead"
                autoComplete="off"
              />
            </div>
            <Button
              type="button"
              disabled={createRole.isPending || !newRoleKey.trim() || !newRoleName.trim()}
              onClick={() => {
                const parsed = createOrgRoleSchema.safeParse({
                  key: newRoleKey,
                  name: newRoleName,
                })
                if (!parsed.success) {
                  toast.error(m.error, { description: m.errValidation })
                  return
                }
                createRole.mutate(parsed.data, {
                  onSuccess: () => {
                    toast.success(m.roleCreated)
                    setNewRoleKey('')
                    setNewRoleName('')
                  },
                  onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
                })
              }}
            >
              {m.orgRoleCreate}
            </Button>
          </div>

          {roles.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : roles.isError ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 py-8 text-center">
              <p className="text-sm font-medium text-destructive">{m.loadFailed}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {apiErrorToMessage(roles.error, m)}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void roles.refetch()}>
                {m.retry}
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {(roles.data?.roles ?? []).map((r) => {
                const patchingThis = patchGrant.isPending && patchGrant.variables?.roleId === r.id
                return (
                  <li key={r.id} className="space-y-2 px-3 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{r.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.key}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {r.isSystem ? (
                          <Badge variant="outline" className="text-[10px]">
                            {m.orgRoleSystem}
                          </Badge>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={deleteRole.isPending}
                            onClick={() => setPendingDeleteRoleId(r.id)}
                          >
                            {m.delete}
                          </Button>
                        )}
                      </div>
                    </div>
                    {r.grants.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{m.orgRoleGrantsEmpty}</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {r.grants.map((g) => {
                          const grantKey = orgRoleGrantKey(r.id, g.moduleId)
                          const displayAccess = optimisticAccess[grantKey]?.access ?? g.access
                          const patchingGrant =
                            patchingThis && patchGrant.variables?.moduleId === g.moduleId
                          if (r.isSystem) {
                            return (
                              <Badge
                                key={grantKey}
                                variant="secondary"
                                className="gap-1 font-mono text-[10px]"
                              >
                                {g.moduleId}
                                <span className="opacity-70">
                                  {accessItems.find((a) => a.value === displayAccess)?.label ??
                                    displayAccess}
                                </span>
                              </Badge>
                            )
                          }
                          return (
                            <div
                              key={grantKey}
                              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
                            >
                              <span className="font-mono text-[11px]">{g.moduleId}</span>
                              <Select
                                items={[...accessItems]}
                                value={displayAccess}
                                onValueChange={(v) => {
                                  if (
                                    (v === 'write' || v === 'read' || v === 'disabled') &&
                                    v !== displayAccess
                                  ) {
                                    patchGrant.mutate({
                                      orgId,
                                      roleId: r.id,
                                      moduleId: g.moduleId,
                                      access: v,
                                    })
                                  }
                                }}
                                disabled={patchingGrant}
                              >
                                <SelectTrigger
                                  className="h-7 w-[6.5rem] text-xs"
                                  aria-label={m.grantAccessLabel.replace('{module}', g.moduleId)}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {accessItems.map((a) => (
                                      <SelectItem key={a.value} value={a.value}>
                                        {a.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!pendingDeleteRoleId}
        onOpenChange={(v) => {
          if (!v) setPendingDeleteRoleId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.delete}</AlertDialogTitle>
            <AlertDialogDescription>{m.confirmDeleteRole}</AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDeleteRole ? (
            <p className="text-sm font-medium">
              {pendingDeleteRole.name}{' '}
              <span className="font-mono text-xs text-muted-foreground">
                ({pendingDeleteRole.key})
              </span>
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteRole.isPending}
              onClick={() =>
                pendingDeleteRoleId &&
                deleteRole.mutate(pendingDeleteRoleId, {
                  onSuccess: () => {
                    toast.success(m.roleDeleted)
                    setPendingDeleteRoleId(null)
                  },
                  onError: (e) => toast.error(m.error, { description: apiErrorToMessage(e, m) }),
                })
              }
            >
              {m.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
