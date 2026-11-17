import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api'

export type Member = {
  id: string
  userId: string
  role: string
  createdAt?: string | number | Date
}

export type Invitation = {
  id: string
  email: string
  role: string
  status: string
  expiresAt: string | null
}

export type ModuleAccess = 'write' | 'read' | 'disabled'

export type OrgRoleGrantInput = {
  orgId: string
  roleId: string
  moduleId: string
  access: ModuleAccess
}

export type PatchOrgRoleGrantHandlers = {
  onMutate?: (input: OrgRoleGrantInput) => void
  onSuccess?: (input: OrgRoleGrantInput) => void
  onError?: (error: unknown, input: OrgRoleGrantInput) => void
}

export function orgRoleGrantKey(roleId: string, moduleId: string): string {
  return `${roleId}:${moduleId}`
}

export function mergeOptimisticGrant(
  prev: Record<string, OrgRoleGrantInput>,
  input: OrgRoleGrantInput,
): Record<string, OrgRoleGrantInput> {
  return { ...prev, [orgRoleGrantKey(input.roleId, input.moduleId)]: input }
}

/** Drop overlay only when it still represents this mutation (not a newer one). */
export function clearOptimisticGrantIfCurrent(
  prev: Record<string, OrgRoleGrantInput>,
  input: OrgRoleGrantInput,
): Record<string, OrgRoleGrantInput> {
  const key = orgRoleGrantKey(input.roleId, input.moduleId)
  if (prev[key] !== input) return prev
  const next = { ...prev }
  delete next[key]
  return next
}

export type OrgRoleRow = {
  id: string
  key: string
  name: string
  isSystem: boolean
  grants: Array<{ moduleId: string; access: ModuleAccess }>
}

export type OrgRolesQuery = UseQueryResult<{ roles: OrgRoleRow[] }>

function orgMembersQueryKey(orgId: string) {
  return ['org-members', orgId] as const
}

function orgInvitationsQueryKey(orgId: string) {
  return ['org-invitations', orgId] as const
}

function orgRolesQueryKey(orgId: string) {
  return ['org-roles', orgId] as const
}

export function useOrgMembers(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: orgMembersQueryKey(orgId),
    queryFn: () => apiFetch<{ members: Member[] }>(`/api/orgs/${orgId}/members`),
    enabled,
  })
}

export function useOrgInvitations(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: orgInvitationsQueryKey(orgId),
    queryFn: () => apiFetch<{ invitations: Invitation[] }>(`/api/orgs/${orgId}/invitations`),
    enabled,
  })
}

export function useOrgRoles(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: orgRolesQueryKey(orgId),
    queryFn: () => apiFetch<{ roles: OrgRoleRow[] }>(`/api/orgs/${orgId}/roles`),
    enabled,
  })
}

export function useInviteMember(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; role: string }) =>
      apiFetch(`/api/orgs/${orgId}/invitations`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orgInvitationsQueryKey(orgId) })
    },
  })
}

export function useCancelInvitation(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiFetch(`/api/orgs/${orgId}/invitations/${invitationId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orgInvitationsQueryKey(orgId) })
    },
  })
}

export function useCreateOrgRole(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; name: string }) =>
      apiFetch(`/api/orgs/${orgId}/roles`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orgRolesQueryKey(orgId) })
    },
  })
}

export function usePatchOrgRoleGrant(handlers?: PatchOrgRoleGrantHandlers) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: OrgRoleGrantInput) =>
      apiFetch(`/api/orgs/${input.orgId}/roles/${input.roleId}/grants/${input.moduleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ access: input.access }),
      }),
    onMutate: (input) => {
      handlers?.onMutate?.(input)
    },
    onSuccess: async (_data, input) => {
      await qc.invalidateQueries({ queryKey: orgRolesQueryKey(input.orgId) })
      handlers?.onSuccess?.(input)
    },
    onError: (error, input) => {
      handlers?.onError?.(error, input)
    },
  })
}

export function useDeleteOrgRole(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (roleId: string) =>
      apiFetch(`/api/orgs/${orgId}/roles/${roleId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orgRolesQueryKey(orgId) })
    },
  })
}
