import {
  type AuthorizationFact,
  authorizeHostedPrincipal,
  type HostedAuthorization,
} from '@kit/auth/snapshot'
import type { z } from 'zod'
import { MAX_SCOPED_DISPATCHES_PER_REQUEST, ORGANIZATION_REFUSAL_CODES } from '../agentWire'
import { type ToolDef, toolRefusal } from '../catalogue'
import { PublicToolError } from '../publicErrors'
import type { HostedMcpEnv } from './env'
import type { GrantPrincipal } from './token-admission'

type Fact = AuthorizationFact<unknown>
type ReadFact = HostedAuthorization['fact']

type PolicyContext<Input> = {
  input: Input
  organization: Readonly<{ id: string; role: string }>
  fact: ReadFact
}

export type OrganizationToolDefinition<Input extends z.ZodType> = Omit<
  ToolDef,
  'input' | 'execute'
> & {
  input: Input
  /** Read-free designation from validated input, or a server default on omission only. */
  organizationId: (input: z.output<Input>) => string | undefined
  policyFacts?: readonly Fact[]
  facts?: readonly Fact[]
  allow: (context: PolicyContext<z.output<Input>>) => boolean
  execute: (
    input: z.output<Input>,
    context: { organizationId: string; fact: ReadFact },
  ) => Promise<unknown>
}

export type OrganizationToolAuthorization = Readonly<{
  fact: ReadFact
  organizationTool: <Input extends z.ZodType>(
    definition: OrganizationToolDefinition<Input>,
  ) => ToolDef
}>

export function isOrganizationFact(fact: Fact) {
  return fact.scope.kind === 'organization' || fact.scope.kind === 'organization-role'
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

function restrictedFact(
  read: ReadFact,
  declared: ReadonlySet<Fact>,
  refusePolicyRead?: () => void,
): ReadFact {
  return <T>(descriptor: AuthorizationFact<T>): T => {
    try {
      if (declared.has(descriptor)) {
        const value = read(descriptor)
        if (!isThenable(value)) return value
        void Promise.resolve(value).then(undefined, () => {})
      }
    } catch {
      // Fall through to the same public error for rejected and unreadable facts.
    }
    refusePolicyRead?.()
    throw new PublicToolError('UNAVAILABLE')
  }
}

const [invalidSelection, callLimit, refused] = ORGANIZATION_REFUSAL_CODES

type ScopedPrincipal = { db: HostedMcpEnv['DB']; principal: GrantPrincipal; denyFact?: Fact }

function isCanonicalDesignation(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && id === id.trim()
}

async function admitOrganization(
  principal: ScopedPrincipal,
  id: string,
  descriptors: readonly Fact[],
) {
  try {
    const result = await authorizeHostedPrincipal({
      ...principal,
      organizationId: id,
      facts: descriptors,
    })
    if (result.status === 'unavailable') throw new PublicToolError('UNAVAILABLE')
    if (result.status !== 'allowed' || !result.organization) return null
    const scope = result.forOrganization(id)
    const role = scope?.organization.membershipRole
    return scope && role ? { role, fact: scope.fact } : null
  } catch {
    throw new PublicToolError('UNAVAILABLE')
  }
}

function checkPolicy<Input>(
  allow: (context: PolicyContext<Input>) => boolean,
  input: Input,
  organization: PolicyContext<Input>['organization'],
  read: ReadFact,
  declared: ReadonlySet<Fact>,
): boolean {
  let failedRead = false
  const fact = restrictedFact(read, declared, () => {
    failedRead = true
  })
  let allowed: unknown
  try {
    allowed = allow({ input, organization, fact })
    if (isThenable(allowed)) void Promise.resolve(allowed).then(undefined, () => {})
  } catch {
    throw new PublicToolError('UNAVAILABLE')
  }
  if (failedRead || (allowed !== true && allowed !== false)) {
    throw new PublicToolError('UNAVAILABLE')
  }
  return allowed
}

export function organizationToolForRequest(
  header: string | null,
  principal: ScopedPrincipal,
): OrganizationToolAuthorization['organizationTool'] {
  const ambiguousHeader = header?.includes(',')
  let dispatched = 0
  return <Input extends z.ZodType>(definition: OrganizationToolDefinition<Input>): ToolDef => {
    const { organizationId, policyFacts, facts, allow, execute, ...tool } = definition
    const policy = new Set(policyFacts)
    const business = new Set(facts)
    const descriptors = [...policy, ...business]
    if (descriptors.some((descriptor) => !isOrganizationFact(descriptor))) {
      throw new TypeError('Organization tools require Organization-scoped facts')
    }
    if (policyFacts?.some((descriptor) => business.has(descriptor))) {
      throw new TypeError('Organization tool policyFacts and facts must be disjoint')
    }
    return {
      ...tool,
      async execute(value) {
        // The catalogue has validated this exact schema and checked the input budget.
        const input = value as z.output<Input>
        const id = organizationId(input)
        if (!isCanonicalDesignation(id) || ambiguousHeader || (header && header !== id)) {
          return toolRefusal({ code: invalidSelection })
        }
        if (dispatched >= MAX_SCOPED_DISPATCHES_PER_REQUEST) return toolRefusal({ code: callLimit })
        dispatched++

        const scope = await admitOrganization(principal, id, descriptors)
        if (!scope) return toolRefusal({ code: refused })
        const allowed = checkPolicy(allow, input, { id, role: scope.role }, scope.fact, policy)
        if (!allowed) return toolRefusal({ code: refused })
        return execute(input, { organizationId: id, fact: restrictedFact(scope.fact, business) })
      },
    }
  }
}
