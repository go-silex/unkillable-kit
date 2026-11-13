import { describe, expect, it } from 'vitest'
import { canAdminFlows, canCancelFlowRun, canCreateFlowRun, canDecideFlowApproval } from './access'
import { staticTokenBudget } from './budget'
import { checkPlan } from './check'
import { DEFAULT_APPROVE_TIMEOUT_HOURS, FLOWS_MODULE_ID } from './constants'
import { DEMO_ECHO_PLAN_YAML } from './fixtures/demo-echo'
import { mintCapabilityGrant } from './mint'
import { createToolRegistry, type ToolRegistry } from './registry'
import { parsePlanDocument, safeParsePlanDocument } from './schema'
import { createRunSnapshot, digestPlan, executionTools, parseRunnerView } from './snapshot'
import { loadPlanFromYaml, PlanYamlError } from './yaml'

const registry = createToolRegistry('reg-1', [
  { name: 'echo', description: 'Echo args', grantClass: 'mintable' },
  { name: 'list_items', description: 'List demo items', grantClass: 'mintable' },
  { name: 'write_demo', description: 'Write demo blob', grantClass: 'never' },
])

const grant = (
  allowedTools: readonly string[],
  registryVersion = 'reg-1',
  allowsInfer = true,
  allowedModels: readonly string[] = ['kit-infer'],
) => ({
  orgId: 'org_1',
  allowedTools,
  registryVersion,
  allowsInfer,
  allowedModels,
})

// Hand-written grants stay for the conformity cases below: checkPlan judges shape, not provenance.
// Sealing does require provenance, so snapshot fixtures mint from a registry crafted so the minted
// set is exactly what the case needs (same `reg-1` label, so the pin still matches).
const echoOnlyRegistry = createToolRegistry('reg-1', [
  { name: 'echo', description: 'Echo args', grantClass: 'mintable' },
  { name: 'list_items', description: 'List demo items', grantClass: 'never' },
])
const nothingMintableRegistry = createToolRegistry('reg-1', [
  { name: 'echo', description: 'Echo args', grantClass: 'never' },
])

const mintFrom = (source: ToolRegistry, canWrite = true) => {
  const minted = mintCapabilityGrant({
    orgId: 'org_1',
    registry: source,
    facts: { moduleEffective: true, canRead: true, canWrite, allowedModels: ['kit-infer'] },
  })
  if (!minted.ok) throw new Error(`fixture grant must mint: ${minted.message}`)
  return minted.grant
}

const BINDING_DOLLAR = '$'
const ph = (id: string) => `${BINDING_DOLLAR}{{ tasks.${id}.output }}`

describe('loadPlanFromYaml + dogfood fixture', () => {
  it('loads demo-echo YAML', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    expect(plan.flows).toBe('v0')
    expect(plan.plan.id).toBe('demo-echo')
    expect(Object.keys(plan.tasks)).toHaveLength(2)
  })

  it('rejects oversized YAML with code', () => {
    const big = `flows: v0\nplan: { id: x }\npermits: { tools: [] }\ntasks: {}\n${'x'.repeat(70_000)}`
    try {
      loadPlanFromYaml(big)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(PlanYamlError)
      expect((e as PlanYamlError).code).toBe('YAML_TOO_LARGE')
    }
  })

  it('rejects agent key', () => {
    const yaml = `
flows: v0
plan:
  id: bad
  max_tokens: 100
permits:
  tools: []
tasks:
  a:
    agent:
      prompt: nope
`
    expect(() => loadPlanFromYaml(yaml)).toThrow(PlanYamlError)
  })

  it('rejects empty string', () => {
    try {
      loadPlanFromYaml('')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as PlanYamlError).code).toBe('YAML_EMPTY')
    }
  })
})

describe('schema re-validation at check/freeze', () => {
  it('refuses unparsed agent task at checkPlan', () => {
    const raw = {
      flows: 'v0',
      plan: { id: 'p', max_tokens: 100 },
      permits: { tools: ['echo'] },
      tasks: { t1: { agent: { prompt: 'x' } } },
    }
    const result = checkPlan(raw, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'SCHEMA_INVALID')).toBe(true)
    }
  })

  it('refuses unparsed agent task at createRunSnapshot', () => {
    const snap = createRunSnapshot({
      plan: {
        flows: 'v0',
        plan: { id: 'p', max_tokens: 100 },
        permits: { tools: ['echo'] },
        tasks: { t1: { agent: { prompt: 'x' } } },
      },
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'u1',
    })
    expect(snap.ok).toBe(false)
  })

  it('requires plan.max_tokens when any infer task', () => {
    const r = safeParsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { infer: { prompt: 'hi' } } },
    })
    expect(r.success).toBe(false)
  })

  it('rejects task with neither invoke nor infer', () => {
    const r = safeParsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: {} },
    })
    expect(r.success).toBe(false)
  })
})

describe('checkPlan authority (grant ∩ permits)', () => {
  it('passes dogfood when grant includes echo', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const result = checkPlan(plan, grant(['echo', 'list_items']), registry)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.effective.tools).toEqual(['echo'])
  })

  it('fails when plan self-lists tool outside grant', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const result = checkPlan(plan, grant([]), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'TOOL_NOT_GRANTED')).toBe(true)
    }
  })

  it('fails permits-superset even when invoke tool is granted', () => {
    // The superset tool is mintable but not granted: this is plan overreach, not org policy.
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo', 'list_items'] },
      tasks: { t1: { invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'TOOL_NOT_GRANTED' && i.path === 'permits.tools'),
      ).toBe(true)
    }
  })

  it('blames org policy, not the plan, when a permitted tool is no longer mintable', () => {
    // A published plan outliving a server-side tightening must not read as "this plan tried to
    // expand its authority": the plan did not change, the policy did.
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['write_demo'] },
      tasks: { t1: { invoke: { tool: 'write_demo' } } },
    })
    const result = checkPlan(plan, grant([]), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'TOOL_NOT_GRANTED')).toBe(false)
      expect(
        result.issues.filter((i) => i.code === 'TOOL_NOT_GRANTABLE').map((i) => i.path),
      ).toEqual(expect.arrayContaining(['permits.tools', 'tasks.t1.invoke.tool']))
    }
  })

  it('fails empty permits with invoke', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: [] },
      tasks: { t1: { invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'EMPTY_PERMITS')).toBe(true)
    }
  })

  it('fails empty permits with infer-only', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', max_tokens: 100 },
      permits: { tools: [] },
      tasks: { t1: { infer: { prompt: 'hi', max_tokens: 50 } } },
    })
    const result = checkPlan(plan, grant([]), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'EMPTY_PERMITS')).toBe(true)
    }
  })

  it('fails TOOL_NOT_IN_PERMITS', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'list_items' } } },
    })
    const result = checkPlan(plan, grant(['echo', 'list_items']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'TOOL_NOT_IN_PERMITS')).toBe(true)
    }
  })

  it('fails UNKNOWN_TASK_EDGE', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { after: ['missing'], invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'UNKNOWN_TASK_EDGE')).toBe(true)
    }
  })

  it('fails UNKNOWN_TASK_EDGE when after names a prototype key', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { after: ['toString'], invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'UNKNOWN_TASK_EDGE')).toBe(true)
    }
  })

  it('fails TOOL_NOT_GRANTABLE when a hand-made grant lists a never-mintable tool', () => {
    // The bypass a rename alone left open: a grant built outside mintCapabilityGrant used to reach
    // a sealed run with a tool the registry declares unmintable.
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['write_demo'] },
      tasks: { t1: { invoke: { tool: 'write_demo' } } },
    })
    const result = checkPlan(plan, grant(['write_demo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.code === 'TOOL_NOT_GRANTABLE' && i.path === 'grant.allowedTools',
        ),
      ).toBe(true)
    }
  })

  it('fails TOOL_NOT_GRANTABLE when a grant lists a tool the registry does not carry', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, grant(['echo', 'ghost']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'TOOL_NOT_GRANTABLE')).toBe(true)
    }
  })

  it('fails a grant outlived by a tightened registry under the same version label', () => {
    // Same `reg-1` label, echo reclassified server-side: the old grant must stop working.
    const tightened = createToolRegistry('reg-1', [
      { name: 'echo', description: 'Echo args', grantClass: 'never' },
      { name: 'list_items', description: 'List demo items', grantClass: 'mintable' },
    ])
    expect(tightened.version).toBe(registry.version)
    expect(tightened.contentDigest).not.toBe(registry.contentDigest)

    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const result = checkPlan(plan, grant(['echo']), tightened)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'TOOL_NOT_GRANTABLE')).toBe(true)
    }
  })

  it('fails TOKEN_CEILING when multi-infer static sum exceeds plan total', () => {
    // per-task default 4096 * 2 = 8192 > plan.max_tokens 5000
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', max_tokens: 5000 },
      permits: { tools: ['echo'] },
      tasks: {
        a: { infer: { prompt: 'one' } },
        b: { infer: { prompt: 'two' } },
      },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'TOKEN_CEILING')).toBe(true)
    }
  })

  it('allows multi-infer when sum of defaults fits plan total', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', model: 'kit-infer', max_tokens: 10_000 },
      permits: { tools: ['echo'] },
      tasks: {
        a: { infer: { prompt: 'one' } },
        b: { infer: { prompt: 'two' } },
      },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(true)
  })

  it('fails REGISTRY_VERSION_MISMATCH', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const result = checkPlan(plan, grant(['echo'], 'old'), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'REGISTRY_VERSION_MISMATCH')).toBe(true)
    }
  })

  it('fails GRANT_INVALID when pin missing', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const result = checkPlan(
      plan,
      { orgId: 'org_1', allowedTools: ['echo'], registryVersion: '', allowsInfer: true },
      registry,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.code === 'GRANT_INVALID' || i.code === 'REGISTRY_VERSION_REQUIRED',
        ),
      ).toBe(true)
    }
  })

  it('detects cycle', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: {
        a: { after: ['b'], invoke: { tool: 'echo' } },
        b: { after: ['a'], invoke: { tool: 'echo' } },
      },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'CYCLE')).toBe(true)
    }
  })

  it('requires orgId on grant', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const result = checkPlan(
      plan,
      { orgId: '', allowedTools: ['echo'], registryVersion: 'reg-1', allowsInfer: true },
      registry,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'GRANT_INVALID' || i.code === 'ORG_ID_REQUIRED'),
      ).toBe(true)
    }
  })
})

describe('createRunSnapshot — sealing requires kit provenance', () => {
  it('refuses a forged grant that is conformant but never minted', () => {
    // The bypass: allowedTools copies the mintable set exactly, so every conformity check passes,
    // and allowsInfer is simply asserted — org policy (canWrite false) says otherwise.
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', max_tokens: 1000 },
      permits: { tools: ['echo'] },
      tasks: { t1: { infer: { prompt: 'x', max_tokens: 100 } } },
    })
    const forged = { orgId: 'org_1', allowedTools: ['echo'], registryVersion: 'reg-1' }
    const snap = createRunSnapshot({
      plan,
      grant: { ...forged, allowsInfer: true },
      registry: echoOnlyRegistry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(false)
    if (!snap.ok) {
      expect(snap.issues.map((i) => i.code)).toEqual(['GRANT_NOT_MINTED'])
    }
  })

  it('refuses a minted grant that was copied or round-tripped through JSON', () => {
    const minted = mintFrom(echoOnlyRegistry)
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    for (const copy of [{ ...minted }, JSON.parse(JSON.stringify(minted)) as unknown]) {
      const snap = createRunSnapshot({
        plan,
        grant: copy,
        registry: echoOnlyRegistry,
        actorId: 'user_1',
      })
      expect(snap.ok).toBe(false)
      if (!snap.ok) expect(snap.issues[0]?.code).toBe('GRANT_NOT_MINTED')
    }
  })

  it('refuses a hand-built registry literal even when it declares everything mintable', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const forgedRegistry: ToolRegistry = {
      version: 'reg-1',
      contentDigest: 'whatever',
      tools: new Map([['echo', { name: 'echo', grantClass: 'mintable' as const }]]),
    }
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry: forgedRegistry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(false)
    if (!snap.ok) {
      expect(snap.issues.map((i) => i.code)).toEqual(['REGISTRY_NOT_KIT_BUILT'])
    }
  })

  it('seals the infer plan the org policy does allow', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', model: 'kit-infer', max_tokens: 1000 },
      permits: { tools: ['echo'] },
      tasks: { t1: { infer: { prompt: 'x', max_tokens: 100 } } },
    })
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry, true),
      registry: echoOnlyRegistry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (snap.ok) expect(snap.runnerView.allowsInfer).toBe(true)
  })

  it('refuses the same infer plan when policy withholds write', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', max_tokens: 1000 },
      permits: { tools: ['echo'] },
      tasks: { t1: { infer: { prompt: 'x', max_tokens: 100 } } },
    })
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry, false),
      registry: echoOnlyRegistry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(false)
    if (!snap.ok) {
      expect(snap.issues.some((i) => i.code === 'INFER_NOT_GRANTED')).toBe(true)
    }
  })
})

describe('createRunSnapshot + parseRunnerView', () => {
  it('freezes runnerView without grant super-set; grantAudit separate', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(registry),
      registry,
      actorId: 'user_1',
      createdAt: '2026-08-06T00:00:00.000Z',
    })
    expect(snap.ok).toBe(true)
    if (snap.ok) {
      expect(snap.runnerView.planDigest).toBe(digestPlan(plan))
      expect(executionTools(snap.runnerView)).toEqual(['echo'])
      expect(snap.runnerView.executionTools).toEqual(['echo'])
      // grant has list_items but the plan does not permit it — must not be on the runner view
      expect(snap.grantAudit.allowedTools).toContain('list_items')
      expect(snap.runnerView.executionTools).not.toContain('list_items')
      expect('grantAudit' in snap.runnerView).toBe(false)
      expect(snap.runnerView.ceilings.hardMaxTokens).toBe(128)
      expect(snap.runnerView.ceilings.staticTokenBudget).toBe(128)
      expect(snap.runnerView.ceilings.planMaxTokens).toBe(2000)
      expect(snap.runnerView.allowsInfer).toBe(true)
      expect(snap.runnerView.registryContentDigest).toBe(registry.contentDigest)
      expect(Object.isFrozen(snap.runnerView)).toBe(true)
      expect(() => {
        ;(snap.runnerView as { actorId: string }).actorId = 'mutated'
      }).toThrow()
    }
  })

  it('refuses snapshot when check fails', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(nothingMintableRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(false)
  })

  it('refuses infer when allowsInfer is false', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry, false),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(false)
    if (!snap.ok) {
      expect(snap.issues.some((i) => i.code === 'INFER_NOT_GRANTED')).toBe(true)
    }
  })

  it('parseRunnerView accepts sealed runnerView JSON', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
      createdAt: '2026-08-06T00:00:00.000Z',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = JSON.parse(JSON.stringify(snap.runnerView))
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(true)
    if (re.ok) {
      expect(re.runnerView.executionTools).toEqual(['echo'])
      expect(re.runnerView.planId).toBe('demo-echo')
      expect(re.runnerView.allowsInfer).toBe(true)
      expect(re.runnerView.runnerViewVersion).toBe(1)
      expect(Object.isFrozen(re.runnerView)).toBe(true)
    }
  })

  it('parseRunnerView rejects grantAudit super-set on the blob', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(registry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = {
      ...JSON.parse(JSON.stringify(snap.runnerView)),
      grantAudit: snap.grantAudit,
    }
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
  })

  it('parseRunnerView rejects executionTools outside sealed permits', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = JSON.parse(JSON.stringify(snap.runnerView))
    wire.executionTools = ['echo', 'write_demo']
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'EXECUTION_TOOL_OUTSIDE_PERMITS')).toBe(true)
    }
  })

  it('parseRunnerView rejects allowsInfer false when sealed plan has infer', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = JSON.parse(JSON.stringify(snap.runnerView))
    wire.allowsInfer = false
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'INFER_NOT_GRANTED')).toBe(true)
    }
  })

  it('parseRunnerView rejects planDigest mismatch', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = JSON.parse(JSON.stringify(snap.runnerView))
    wire.planDigest = 'deadbeef'
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'PLAN_DIGEST_MISMATCH')).toBe(true)
    }
  })

  it('parseRunnerView rejects forged ceilings', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = JSON.parse(JSON.stringify(snap.runnerView))
    wire.ceilings.hardMaxTokens = 999_999
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'CEILING_MISMATCH')).toBe(true)
    }
  })

  it('parseRunnerView rejects planId mismatch', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = JSON.parse(JSON.stringify(snap.runnerView))
    wire.planId = 'other-id'
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'PLAN_ID_MISMATCH')).toBe(true)
    }
  })

  it('parseRunnerView rejects grantAudit with RUNNER_VIEW_INVALID', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(registry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = {
      ...JSON.parse(JSON.stringify(snap.runnerView)),
      grantAudit: snap.grantAudit,
    }
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'RUNNER_VIEW_INVALID')).toBe(true)
    }
  })

  it('parseRunnerView rejects toolEffects key outside executionTools', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = {
      ...JSON.parse(JSON.stringify(snap.runnerView)),
      toolEffects: { echo: 'read', forged: 'read' },
    }
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'TOOL_EFFECT_OUTSIDE_EXECUTION_TOOLS')).toBe(true)
    }
  })

  it('parseRunnerView rejects bad toolEffects enum', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const wire = {
      ...JSON.parse(JSON.stringify(snap.runnerView)),
      toolEffects: { echo: 'external' },
    }
    const re = parseRunnerView(wire)
    expect(re.ok).toBe(false)
    if (!re.ok) {
      expect(re.issues.some((i) => i.code === 'RUNNER_VIEW_INVALID')).toBe(true)
    }
  })

  it('all-write createRunSnapshot omits toolEffects (pre-Roxabi/roxabi-boilerplate-cf#234 strict compatible)', () => {
    const echoPlan = loadPlanFromYaml(`flows: v0
plan:
  id: echo-only-seal
permits:
  tools:
    - echo
tasks:
  echo_hello:
    invoke:
      tool: echo
`)
    const snap = createRunSnapshot({
      plan: echoPlan,
      grant: mintFrom(echoOnlyRegistry, false),
      registry: echoOnlyRegistry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.runnerView.toolEffects).toBeUndefined()
    expect(JSON.parse(JSON.stringify(snap.runnerView))).not.toHaveProperty('toolEffects')
  })

  it('createRunSnapshot refuses empty actorId', () => {
    const plan = loadPlanFromYaml(DEMO_ECHO_PLAN_YAML)
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry),
      registry,
      actorId: '',
    })
    expect(snap.ok).toBe(false)
  })
})

describe('registry', () => {
  it('freezes tool map against mutation', () => {
    expect(() => {
      ;(registry.tools as Map<string, unknown>).set('nuke', { name: 'nuke' })
    }).toThrow()
  })

  it('exposes contentDigest', () => {
    expect(registry.contentDigest).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('planDocumentSchema z.record (Zod 4)', () => {
  it('parses multi-task plan with string-keyed invoke.args', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: {
        t1: { invoke: { tool: 'echo', args: { message: 'hi', n: 1 } } },
        t2: { after: ['t1'], invoke: { tool: 'echo', args: { message: 'bye' } } },
      },
    })
    expect(plan.tasks.t1.invoke?.args).toEqual({ message: 'hi', n: 1 })
    expect(Object.keys(plan.tasks)).toEqual(['t1', 't2'])
  })

  it('rejects non-object invoke.args', () => {
    const r = safeParsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'echo', args: ['not', 'a', 'record'] } } },
    })
    expect(r.success).toBe(false)
  })

  it('rejects invalid task id keys (nonEmptyId)', () => {
    const r = safeParsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { '9bad': { invoke: { tool: 'echo' } } },
    })
    expect(r.success).toBe(false)
  })
})

describe('V0 admin access', () => {
  it('owner/admin can admin flows; member/operator cannot (no platform shortcut)', () => {
    expect(canAdminFlows({ orgRole: 'owner' })).toBe(true)
    expect(canAdminFlows({ orgRole: 'admin' })).toBe(true)
    expect(canAdminFlows({ orgRole: 'member' })).toBe(false)
    expect(canAdminFlows({ orgRole: 'operator' })).toBe(false)
  })

  it('create run: only explicit session + org admin; omit/api_key/member deny', () => {
    expect(canCreateFlowRun({ orgRole: 'admin', authMethod: 'api_key' })).toBe(false)
    expect(canCreateFlowRun({ orgRole: 'admin', authMethod: undefined })).toBe(false)
    expect(canCreateFlowRun({ orgRole: 'admin', authMethod: null })).toBe(false)
    expect(canCreateFlowRun({ orgRole: 'member', authMethod: 'session' })).toBe(false)
    expect(canCreateFlowRun({ orgRole: 'operator', authMethod: 'session' })).toBe(false)
    expect(canCreateFlowRun({ orgRole: 'admin', authMethod: 'session' })).toBe(true)
  })

  it('cancel run matches decide approval: session owner/admin only, no super_admin shortcut', () => {
    expect(canCancelFlowRun({ orgRole: 'admin', authMethod: 'session' })).toBe(true)
    expect(canCancelFlowRun({ orgRole: 'owner', authMethod: 'session' })).toBe(true)
    expect(canCancelFlowRun({ orgRole: 'member', authMethod: 'session' })).toBe(false)
    expect(canCancelFlowRun({ orgRole: 'admin', authMethod: 'api_key' })).toBe(false)
    expect(canCancelFlowRun({ orgRole: 'admin', authMethod: undefined })).toBe(false)
    expect(canDecideFlowApproval({ orgRole: 'admin', authMethod: 'session' })).toBe(true)
    expect(canCancelFlowRun({ orgRole: 'admin', authMethod: 'session' })).toBe(
      canDecideFlowApproval({ orgRole: 'admin', authMethod: 'session' }),
    )
    expect(canCancelFlowRun({ orgRole: 'member', authMethod: 'session' })).toBe(
      canDecideFlowApproval({ orgRole: 'member', authMethod: 'session' }),
    )
  })
})

describe('module id', () => {
  it('exports flows module id', () => {
    expect(FLOWS_MODULE_ID).toBe('flows')
  })
})

describe('approve task', () => {
  it('accepts exactly one approve body and rejects invoke+approve', () => {
    const ok = safeParsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: [] },
      tasks: { gate: { approve: { note: 'hold', timeout_hours: 2 } } },
    })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.tasks.gate?.approve?.timeout_hours).toBe(2)
    }
    expect(DEFAULT_APPROVE_TIMEOUT_HOURS).toBe(24)

    const both = safeParsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { gate: { approve: {}, invoke: { tool: 'echo' } } },
    })
    expect(both.success).toBe(false)
    if (!both.success) {
      expect(both.error.issues.some((i) => i.message.includes('invoke | infer | approve'))).toBe(
        true,
      )
    }
  })

  it('passes an approve-only plan with empty permits and costs 0 tokens', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: [] },
      tasks: { gate: { approve: {} }, later: { after: ['gate'], approve: { note: 'second' } } },
    })
    const result = checkPlan(plan, grant([]), registry)
    expect(result.ok).toBe(true)
    expect(staticTokenBudget(plan)).toBe(0)
    expect(result.ok && result.effective.tools).toEqual([])
  })

  it('still fail-closes empty permits when approve is paired with invoke', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: [] },
      tasks: {
        gate: { approve: {} },
        echo_hello: { after: ['gate'], invoke: { tool: 'echo' } },
      },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'EMPTY_PERMITS')).toBe(true)
    }
  })

  it('rejects timeout_hours and note outside the documented bounds', () => {
    const base = { flows: 'v0', plan: { id: 'p' }, permits: { tools: [] } }
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { timeout_hours: 0 } } } })
        .success,
    ).toBe(false)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { timeout_hours: 169 } } } })
        .success,
    ).toBe(false)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { timeout_hours: 1 } } } })
        .success,
    ).toBe(true)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { timeout_hours: 168 } } } })
        .success,
    ).toBe(true)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { note: '' } } } }).success,
    ).toBe(false)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { note: 'x'.repeat(501) } } } })
        .success,
    ).toBe(false)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { note: 'x' } } } }).success,
    ).toBe(true)
    expect(
      safeParsePlanDocument({ ...base, tasks: { gate: { approve: { note: 'x'.repeat(500) } } } })
        .success,
    ).toBe(true)
  })
})

describe('checkPlan model allowlist (Roxabi/roxabi-boilerplate-cf#227)', () => {
  const withModels = (allowedModels: readonly string[], allowsInfer = true) => ({
    ...grant(['echo'], 'reg-1', allowsInfer),
    allowedModels,
  })

  const inferPlan = (model?: string, taskModel?: string) =>
    parsePlanDocument({
      flows: 'v0',
      plan: {
        id: 'p',
        max_tokens: 100,
        ...(model === undefined ? {} : { model }),
      },
      permits: { tools: ['echo'] },
      tasks: {
        t1: {
          infer: {
            prompt: 'hi',
            max_tokens: 50,
            ...(taskModel === undefined ? {} : { model: taskModel }),
          },
        },
      },
    })

  it('fails EMPTY_MODELS when an infer task meets an empty allowlist', () => {
    const result = checkPlan(inferPlan('kit-infer'), withModels([]), registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((i) => i.code)).toContain('EMPTY_MODELS')
  })

  it('fails MODEL_NOT_GRANTED when the effective model is outside the grant', () => {
    const result = checkPlan(
      inferPlan(undefined, 'other-model'),
      withModels(['kit-infer']),
      registry,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.code === 'MODEL_NOT_GRANTED')).toBe(true)
  })

  it('passes when the task model is in the minted list', () => {
    const result = checkPlan(inferPlan(undefined, 'kit-infer'), withModels(['kit-infer']), registry)
    expect(result.ok).toBe(true)
  })

  it('fails MODEL_NOT_GRANTED when both task and plan omit the model', () => {
    const result = checkPlan(inferPlan(), withModels(['kit-infer']), registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.code === 'MODEL_NOT_GRANTED')).toBe(true)
  })

  it('fails MODEL_NOT_GRANTED when plan.model is outside the list even if every task overrides it', () => {
    const result = checkPlan(
      inferPlan('plan-only', 'kit-infer'),
      withModels(['kit-infer']),
      registry,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.code === 'MODEL_NOT_GRANTED')).toBe(true)
  })

  it('fails MODEL_NOT_GRANTED at the task path when plan.model is granted and the task model is not', () => {
    const result = checkPlan(
      inferPlan('kit-infer', 'gpt-evil'),
      withModels(['kit-infer']),
      registry,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_NOT_GRANTED',
          path: 'tasks.t1.infer.model',
        }),
      ]),
    )
  })

  it('fails MODEL_NOT_GRANTED on a later infer task when only that model is ungranted', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p', max_tokens: 200 },
      permits: { tools: ['echo'] },
      tasks: {
        a: { infer: { prompt: 'one', max_tokens: 10, model: 'kit-infer' } },
        b: { infer: { prompt: 'two', max_tokens: 10, model: 'gpt-evil' } },
      },
    })
    const result = checkPlan(plan, withModels(['kit-infer']), registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_NOT_GRANTED',
          path: 'tasks.b.infer.model',
        }),
      ]),
    )
  })

  it('passes an invoke-only plan when the allowlist is empty', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'echo' } } },
    })
    const result = checkPlan(plan, withModels([]), registry)
    expect(result.ok).toBe(true)
  })

  it('seals a runner view without allowedModels and keeps version 1', () => {
    const plan = inferPlan(undefined, 'kit-infer')
    const snap = createRunSnapshot({
      plan,
      grant: mintFrom(echoOnlyRegistry, true),
      registry: echoOnlyRegistry,
      actorId: 'user_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.runnerView.runnerViewVersion).toBe(1)
    expect('allowedModels' in snap.runnerView).toBe(false)
    expect(parseRunnerView({ ...snap.runnerView, allowedModels: ['kit-infer'] }).ok).toBe(false)
  })
})

describe('whole-value bindings (Roxabi/roxabi-boilerplate-cf#232)', () => {
  it('accepts whole binding and seals derived after even when authored after omitted', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: {
        a: { invoke: { tool: 'echo', args: { text: 'hi' } } },
        b: { invoke: { tool: 'echo', args: { text: ph('a') } } },
      },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(true)
    const minted = mintFrom(echoOnlyRegistry)
    const snap = createRunSnapshot({
      plan,
      grant: minted,
      registry: echoOnlyRegistry,
      actorId: 'actor_1',
    })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.runnerView.sealedPlan.tasks.b?.after).toEqual(['a'])
    expect(JSON.stringify(snap.runnerView)).toContain(ph('a'))
    expect(JSON.stringify(snap.runnerView)).not.toContain('process.env')
  })

  it('fails BINDING_NOT_WHOLE on interpolated bindings', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: {
        a: { invoke: { tool: 'echo' } },
        b: { invoke: { tool: 'echo', args: { text: `prefix ${ph('a')}` } } },
      },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'BINDING_NOT_WHOLE')).toBe(true)
      expect(result.issues.some((i) => i.path === 'tasks.b.invoke.args.text')).toBe(true)
    }
  })

  it('fails ARG_KEY_FORBIDDEN on secret-shaped keys', () => {
    const plan = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'echo', args: { api_key: 'x' } } } },
    })
    const result = checkPlan(plan, grant(['echo']), registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'ARG_KEY_FORBIDDEN')).toBe(true)
    }
  })

  it('fails UNKNOWN_TASK_EDGE for binding to unknown id and CYCLE via bindings', () => {
    const missing = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: { t1: { invoke: { tool: 'echo', args: { text: ph('ghost') } } } },
    })
    const missingResult = checkPlan(missing, grant(['echo']), registry)
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) {
      expect(missingResult.issues.some((i) => i.code === 'UNKNOWN_TASK_EDGE')).toBe(true)
    }

    const cyclic = parsePlanDocument({
      flows: 'v0',
      plan: { id: 'p' },
      permits: { tools: ['echo'] },
      tasks: {
        a: { invoke: { tool: 'echo', args: { text: ph('b') } } },
        b: { invoke: { tool: 'echo', args: { text: ph('a') } } },
      },
    })
    const cyclicResult = checkPlan(cyclic, grant(['echo']), registry)
    expect(cyclicResult.ok).toBe(false)
    if (!cyclicResult.ok) {
      expect(cyclicResult.issues.some((i) => i.code === 'CYCLE')).toBe(true)
    }
  })
})
