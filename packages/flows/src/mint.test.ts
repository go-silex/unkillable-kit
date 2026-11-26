import { describe, expect, it } from 'vitest'
import { checkPlan } from './check'
import { MAX_PERMIT_TOOLS } from './constants'
import { parseCapabilityGrant } from './grant'
import { mintCapabilityGrant, type OrgPolicyFacts } from './mint'
import { createToolRegistry, type ToolGrantClass, type ToolRegistry } from './registry'
import { parsePlanDocument } from './schema'

const mixedRegistry = createToolRegistry('reg-1', [
  { name: 'zeta_read', grantClass: 'mintable' },
  { name: 'echo', description: 'Echo args', grantClass: 'mintable' },
  { name: 'write_demo', description: 'Write demo blob', grantClass: 'never' },
  { name: 'fetch_url', description: 'External fetch', grantClass: 'never' },
])

const factsOf = (over: Partial<OrgPolicyFacts> = {}): OrgPolicyFacts => ({
  moduleEffective: true,
  canRead: true,
  canWrite: false,
  allowedModels: [],
  ...over,
})

const mint = (over: { orgId?: string; registry?: ToolRegistry; facts?: OrgPolicyFacts } = {}) =>
  mintCapabilityGrant({
    orgId: over.orgId ?? 'org_1',
    registry: over.registry ?? mixedRegistry,
    facts: over.facts ?? factsOf(),
  })

describe("mintCapabilityGrant — grants only tools declared 'mintable'", () => {
  it("includes every 'mintable' tool and no 'never' tool", () => {
    const r = mint()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grant.allowedTools).toEqual(['echo', 'zeta_read'])
    expect(r.grant.allowedTools).not.toContain('write_demo')
    expect(r.grant.allowedTools).not.toContain('fetch_url')
  })

  it('never mints a class it does not know, even from a hand-built registry', () => {
    const handBuilt: ToolRegistry = {
      version: 'reg-hand',
      contentDigest: 'unused',
      tools: new Map([['echo', { name: 'echo', grantClass: 'read' as never }]]),
    }
    const r = mint({ registry: handBuilt })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grant.allowedTools).toEqual([])
  })
})

describe('mintCapabilityGrant — fail-closed policy order', () => {
  it('denies MODULE_NOT_EFFECTIVE when the module is off even if canRead/canWrite are true', () => {
    const r = mint({ facts: factsOf({ moduleEffective: false, canRead: true, canWrite: true }) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MODULE_NOT_EFFECTIVE')
    expect(r.message.length).toBeGreaterThan(0)
  })

  it('denies MODULE_ACCESS_DENIED when canRead is false', () => {
    const r = mint({ facts: factsOf({ canRead: false, canWrite: true }) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MODULE_ACCESS_DENIED')
  })

  it('denies ORG_ID_REQUIRED for empty or whitespace orgId', () => {
    for (const orgId of ['', '   ', '\n\t']) {
      const r = mint({ orgId })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe('ORG_ID_REQUIRED')
    }
  })

  it('denies GRANT_INVALID for an orgId with surrounding whitespace instead of trimming it', () => {
    for (const orgId of [' org_1 ', 'org_1 ', '\torg_1', 'org_1\n']) {
      const r = mint({ orgId })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe('GRANT_INVALID')
    }
  })
})

describe('mintCapabilityGrant — allowsInfer is explicit from canWrite', () => {
  it('mirrors canWrite in both directions and is never true merely because tools were granted', () => {
    const withToolsNoWrite = mint({ facts: factsOf({ canWrite: false }) })
    expect(withToolsNoWrite.ok).toBe(true)
    if (!withToolsNoWrite.ok) return
    expect(withToolsNoWrite.grant.allowedTools.length).toBeGreaterThan(0)
    expect(withToolsNoWrite.grant.allowsInfer).toBe(false)

    const withToolsAndWrite = mint({ facts: factsOf({ canWrite: true }) })
    expect(withToolsAndWrite.ok).toBe(true)
    if (!withToolsAndWrite.ok) return
    expect(withToolsAndWrite.grant.allowsInfer).toBe(true)

    const writeOnlyRegistry = createToolRegistry('reg-write', [
      { name: 'write_demo', grantClass: 'never' },
    ])
    const inferWithoutTools = mint({
      registry: writeOnlyRegistry,
      facts: factsOf({ canWrite: true }),
    })
    expect(inferWithoutTools.ok).toBe(true)
    if (!inferWithoutTools.ok) return
    expect(inferWithoutTools.grant.allowedTools).toEqual([])
    expect(inferWithoutTools.grant.allowsInfer).toBe(true)
  })
})

describe('mintCapabilityGrant — registry pin and parse', () => {
  it('sets registryVersion equal to registry.version', () => {
    const r = mint()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grant.registryVersion).toBe(mixedRegistry.version)
  })

  it('returns a grant accepted by parseCapabilityGrant', () => {
    const r = mint({ facts: factsOf({ canWrite: true }) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = parseCapabilityGrant(r.grant)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.grant).toEqual(r.grant)
  })

  it('fails GRANT_INVALID when mintable tools exceed MAX_PERMIT_TOOLS (no silent truncate)', () => {
    const tools = Array.from({ length: MAX_PERMIT_TOOLS + 1 }, (_, i) => ({
      name: `t${i}`,
      grantClass: 'mintable' as const,
    }))
    const registry = createToolRegistry('reg-overflow', tools)
    const r = mint({ registry })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('GRANT_INVALID')
    expect(r.message.length).toBeGreaterThan(0)
  })
})

describe('mintCapabilityGrant — checkPlan: permits only narrow', () => {
  it('fed to checkPlan with a permits-narrowing plan, effective.tools ⊆ allowedTools', () => {
    const registry = createToolRegistry('reg-1', [
      { name: 'echo', grantClass: 'mintable' },
      { name: 'list_items', grantClass: 'mintable' },
      { name: 'write_demo', grantClass: 'never' },
    ])
    const minted = mint({ registry, facts: factsOf({ canWrite: false }) })
    expect(minted.ok).toBe(true)
    if (!minted.ok) return
    expect(minted.grant.allowedTools).toEqual(['echo', 'list_items'])

    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, minted.grant, registry)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.effective.tools).toEqual(['echo'])
    const allowed = new Set(minted.grant.allowedTools)
    expect(result.effective.tools.every((t) => allowed.has(t))).toBe(true)
    expect(result.effective.tools).not.toContain('list_items')
    expect(result.effective.tools).not.toContain('write_demo')
  })

  it('fails closed in checkPlan when every minted tool sits outside plan permits', () => {
    const registry = createToolRegistry('reg-1', [
      { name: 'echo', grantClass: 'mintable' },
      { name: 'write_demo', grantClass: 'never' },
    ])
    const minted = mint({ registry })
    expect(minted.ok).toBe(true)
    if (!minted.ok) return
    expect(minted.grant.allowedTools).toEqual(['echo'])

    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: [] },
      tasks: { t1: { invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, minted.grant, registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.code === 'EMPTY_PERMITS')).toBe(true)
  })
})

describe('mintCapabilityGrant — snapshot isolation', () => {
  it('mutating the input registry or facts object after minting does not change the returned grant', () => {
    const tools = new Map<string, { name: string; grantClass: ToolGrantClass }>([
      ['echo', { name: 'echo', grantClass: 'mintable' }],
    ])
    const registry: ToolRegistry = {
      version: 'reg-mut',
      contentDigest: 'unused',
      tools,
    }
    const facts = factsOf({ canWrite: true })
    const r = mint({ orgId: 'org_1', registry, facts })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    facts.canWrite = false
    facts.canRead = false
    facts.moduleEffective = false
    tools.set('sneaky', { name: 'sneaky', grantClass: 'mintable' })
    tools.delete('echo')
    registry.version = 'reg-mutated'

    expect(r.grant.allowsInfer).toBe(true)
    expect(r.grant.allowedTools).toEqual(['echo'])
    expect(r.grant.allowedTools).not.toContain('sneaky')
    expect(r.grant.registryVersion).toBe('reg-mut')
  })
})

describe('mintCapabilityGrant — allowedModels come from facts only', () => {
  it('copies a sorted unique list and does not keep the caller array', () => {
    const allowedModels = ['zeta', 'alpha', 'zeta']
    const r = mint({ facts: factsOf({ allowedModels }) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grant.allowedModels).toEqual(['alpha', 'zeta'])
    allowedModels.push('smuggled')
    expect(r.grant.allowedModels).toEqual(['alpha', 'zeta'])
  })
})
