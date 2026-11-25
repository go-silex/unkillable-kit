import { FLOWS_ADMIN_ROLES, type FlowsAdminRole } from './constants'

type FlowAuthMethod = 'session' | 'api_key' | 'mcp' | null | undefined

export function isFlowsAdminRole(role: string | null | undefined): role is FlowsAdminRole {
  if (!role) return false
  return (FLOWS_ADMIN_ROLES as readonly string[]).includes(role)
}

/**
 * Flows plan admin (enable/disable, publish): org owner/admin only.
 * Platform `super_admin` is not a shortcut (ADR-0005 D3/D4) — matches `canDecideFlowApproval`.
 */
export function canAdminFlows(input: { orgRole: string | null | undefined }): boolean {
  return isFlowsAdminRole(input.orgRole)
}

/**
 * V0: only explicit session + org owner/admin may create runs.
 * Missing authMethod → deny (fail-closed; never treat omit as session).
 * api_key → deny until scoped keys land; mcp → deny.
 * Platform role is never a shortcut (Roxabi/roxabi-boilerplate-cf#286).
 */
export function canCreateFlowRun(input: {
  orgRole: string | null | undefined
  /** Required. Omitted/unknown → deny. */
  authMethod: FlowAuthMethod
}): boolean {
  if (input.authMethod !== 'session') return false
  return canAdminFlows(input)
}

/**
 * HITL decide: session + org owner/admin only.
 * super_admin is not a shortcut (ADR-0005 D3/D4). api_key / mcp / omitted auth → deny.
 */
export function canDecideFlowApproval(input: {
  orgRole: string | null | undefined
  authMethod: FlowAuthMethod
}): boolean {
  if (input.authMethod !== 'session') return false
  return isFlowsAdminRole(input.orgRole)
}

/**
 * Cancel run: same rule as HITL decide — session + org owner/admin only.
 * super_admin is not a shortcut. api_key / mcp / omitted auth → deny.
 */
export function canCancelFlowRun(input: {
  orgRole: string | null | undefined
  authMethod: FlowAuthMethod
}): boolean {
  return canDecideFlowApproval(input)
}
