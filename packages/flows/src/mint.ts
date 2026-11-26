/**
 * The only production constructor of a `CapabilityGrant`.
 * Facts are resolved by the caller from org module policy — never from client
 * input, plan body, or agent self-description. Permits may only narrow.
 */
import type { CapabilityGrant } from './authority'
import { parseCapabilityGrant } from './grant'
import { markMintedGrant } from './provenance'
import type { ToolRegistry } from './registry'

/** Policy facts resolved by the caller (org module policy — never client input). */
export type OrgPolicyFacts = {
  /** platform_modules.available AND organization_modules.enabled (ADR-0003 D7). */
  moduleEffective: boolean
  /** role-module access for op 'read'. */
  canRead: boolean
  /** role-module access for op 'write'. */
  canWrite: boolean
  /**
   * Model ids from server env (`FLOW_ALLOWED_MODELS`). Never from the plan body,
   * the client, or an agent self-description. Unset env is `[]`, not allow-all.
   */
  allowedModels: readonly string[]
}

export type MintGrantInput = {
  /**
   * Request-scoped org id (server-resolved: path param / X-Org-Id middleware), exactly the value
   * the facts were resolved for. Never normalized here: surrounding whitespace is denied.
   */
  orgId: string
  /** Server-owned tool registry. NEVER built from a request body. */
  registry: ToolRegistry
  facts: OrgPolicyFacts
}

export type MintDenyCode =
  | 'ORG_ID_REQUIRED'
  | 'MODULE_NOT_EFFECTIVE'
  | 'MODULE_ACCESS_DENIED'
  | 'GRANT_INVALID'

export type MintGrantResult =
  | { ok: true; grant: CapabilityGrant }
  | { ok: false; code: MintDenyCode; message: string }

/**
 * Mint a grant from caller-resolved org module policy. Pure; fail-closed.
 *
 * @capability flows-grant-mint
 * @invariant grant-ceiling-is-declared-mintable: the minted allowlist is exactly the registry
 * tools declared `grantClass: 'mintable'`; a `'never'` tool is never minted. This constructor is
 * the only production source of that ceiling (AGENTS.md invariant 3) and `checkPlan` re-verifies
 * the property on whatever grant it is handed — ADR-0005 D4 amendment.
 */
export function mintCapabilityGrant(input: MintGrantInput): MintGrantResult {
  const orgId = input.orgId
  if (!orgId.trim()) {
    return { ok: false, code: 'ORG_ID_REQUIRED', message: 'orgId is required' }
  }
  // The grant binds the id the caller resolved facts for; a trimmed copy could name another org.
  if (orgId !== orgId.trim()) {
    return {
      ok: false,
      code: 'GRANT_INVALID',
      message: 'orgId must not have leading or trailing whitespace',
    }
  }
  if (input.facts.moduleEffective !== true) {
    return {
      ok: false,
      code: 'MODULE_NOT_EFFECTIVE',
      message: 'flows module is not effective for this org',
    }
  }
  if (input.facts.canRead !== true) {
    return {
      ok: false,
      code: 'MODULE_ACCESS_DENIED',
      message: 'role does not have read access to the flows module',
    }
  }
  // `'mintable'` is the permissive value here: these tools become the grant ceiling.
  const allowedTools = [
    ...new Set(
      [...input.registry.tools.values()]
        .filter((def) => def.grantClass === 'mintable')
        .map((def) => def.name),
    ),
  ].sort()
  const allowsInfer = input.facts.canWrite === true
  const registryVersion = input.registry.version
  const allowedModels = [...new Set(input.facts.allowedModels)].sort()

  const parsed = parseCapabilityGrant({
    orgId,
    allowedTools,
    registryVersion,
    allowsInfer,
    allowedModels,
  })
  if (!parsed.ok) {
    return { ok: false, code: 'GRANT_INVALID', message: parsed.message }
  }
  // Provenance is recorded here, and required by `createRunSnapshot`: conformity against the
  // registry cannot cover `allowsInfer`, which comes from policy facts the registry never sees.
  return { ok: true, grant: markMintedGrant(parsed.grant) }
}
