import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@kit/ui'
import { useParams } from '@tanstack/react-router'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '../components/app-shell'
import { OrgRolesCard } from '../components/org-roles-card'
import { apiErrorToMessage } from '../lib/api'
import { canManageMembers, useMe } from '../lib/auth'
import { useLocale } from '../lib/locale'
import {
  useCancelInvitation,
  useOrgInvitations,
  useOrgMembers,
  useOrgRoles,
} from '../lib/org-members'
import { orgRoleLabel } from '../lib/org-role'
import { OrgMembersInviteCard } from './org-members-invite'

function OrgMembersManagedBody({
  orgId,
  invitations,
  members,
  cancel,
  roles,
  roleNameByKey,
  m,
}: {
  orgId: string
  invitations: ReturnType<typeof useOrgInvitations>
  members: ReturnType<typeof useOrgMembers>
  cancel: ReturnType<typeof useCancelInvitation>
  roles: ReturnType<typeof useOrgRoles>
  roleNameByKey: Map<string, string>
  m: ReturnType<typeof useLocale>['m']
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.invitePending}</CardTitle>
        </CardHeader>
        <CardContent>
          {invitations.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : invitations.isError ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 py-8 text-center">
              <p className="text-sm font-medium text-destructive">{m.loadFailed}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {apiErrorToMessage(invitations.error, m)}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void invitations.refetch()}>
                {m.retry}
              </Button>
            </div>
          ) : invitations.data?.invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.inviteEmpty}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {invitations.data?.invitations.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{inv.email}</div>
                    <div className="text-xs text-muted-foreground">
                      {orgRoleLabel(inv.role, m, roleNameByKey)}
                      {inv.expiresAt
                        ? ` · ${m.inviteExpires} ${new Date(inv.expiresAt).toLocaleDateString()}`
                        : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {inv.status}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={cancel.isPending}
                      onClick={() =>
                        cancel.mutate(inv.id, {
                          onSuccess: () => toast.success(m.inviteCanceled),
                          onError: (err) =>
                            toast.error(m.error, { description: apiErrorToMessage(err, m) }),
                        })
                      }
                    >
                      {m.inviteCancel}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.membersList}</CardTitle>
        </CardHeader>
        <CardContent>
          {members.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : members.isError ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 py-8 text-center">
              <p className="text-sm font-medium text-destructive">{m.loadFailed}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {apiErrorToMessage(members.error, m)}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void members.refetch()}>
                {m.retry}
              </Button>
            </div>
          ) : (members.data?.members.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{m.membersEmpty}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {members.data?.members.map((mem) => (
                <li
                  key={mem.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{mem.userId}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {orgRoleLabel(mem.role, m, roleNameByKey)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <OrgRolesCard key={orgId} orgId={orgId} roles={roles} />
    </>
  )
}

export function OrgMembersPage() {
  const { m } = useLocale()
  const me = useMe()
  const { orgId } = useParams({ from: '/app/orgs/$orgId/members' })
  const canManage = canManageMembers(me.data, orgId)
  const org = me.data?.orgs?.find((o) => o.id === orgId)

  const enabled = Boolean(orgId) && canManage
  const members = useOrgMembers(orgId, enabled)
  const invitations = useOrgInvitations(orgId, enabled)
  const roles = useOrgRoles(orgId, enabled)

  const roleNameByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of roles.data?.roles ?? []) map.set(r.key, r.name)
    return map
  }, [roles.data?.roles])

  const cancel = useCancelInvitation(orgId)

  if (!canManage) {
    return (
      <div>
        <PageHeader title={m.navMembers} description={m.forbiddenDesc} />
        <p className="text-sm text-muted-foreground">{m.inviteNoPermission}</p>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title={m.navMembers} description={org ? `${org.name} · ${org.slug}` : orgId} />

      <div className="grid max-w-3xl gap-4">
        <OrgMembersInviteCard orgId={orgId} roleNameByKey={roleNameByKey} />

        <OrgMembersManagedBody
          orgId={orgId}
          invitations={invitations}
          members={members}
          cancel={cancel}
          roles={roles}
          roleNameByKey={roleNameByKey}
          m={m}
        />
      </div>
    </div>
  )
}
