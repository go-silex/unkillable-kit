import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  type DestinationFacts,
  defineNotificationRegistry,
  defineNotificationType,
  isOrganizationDeliveryEligible,
  isUserDeliveryEligible,
  type RegistryEntry,
  type Rule,
  resolveOrganizationDestination,
  resolveUserNotification,
  type UserRule,
  validateNotificationRule,
} from './index'

const params = z.strictObject({ title: z.string() })
type Messages = { email: { subject: string; text: string }; slack: { text: string } }
const definition = defineNotificationType<typeof params, Messages, 'en'>({
  category: 'sample',
  params,
  channels: ['email', 'slack'],
  defaultOn: ['email', 'slack'],
  organizationDestinations: true,
  render: {
    in_app: ({ params, href }) => ({ title: params.title, body: '', href }),
    email: ({ params }) => ({ subject: params.title, text: params.title }),
    slack: ({ params }) => ({ text: params.title }),
  },
})
const other = defineNotificationType<typeof params, Messages, 'en'>({
  category: 'other',
  params,
  channels: ['slack'],
  defaultOn: [],
  render: { in_app: ({ href }) => ({ title: '', body: '', href }), slack: () => ({ text: '' }) },
})
const registry = defineNotificationRegistry({ 'sample.event': definition, 'other.event': other })
const all = { kind: 'all' } as const
const category = { kind: 'category', value: 'sample' } as const
const type = { kind: 'type', value: 'sample.event' } as const
const access = { organizationActive: true, member: true, moduleReadable: true }
const rule = (
  enabled: boolean,
  locked = false,
  selector: Rule['selector'] = all,
  channel = 'slack',
): Rule => ({ selector, channel, enabled, locked })
const user = (enabled: boolean, selector: Rule['selector'] = all): UserRule => ({
  selector,
  channel: 'slack',
  enabled,
  locked: false,
})
const resolve = (
  deploymentRules: readonly Rule[] = [],
  organizationRules: readonly Rule[] = [],
  userRules: readonly UserRule[] = [],
  facts = access,
) =>
  resolveUserNotification({
    typeKey: 'sample.event',
    type: definition,
    access: facts,
    deploymentRules,
    organizationRules,
    userRules,
  })
const destination: DestinationFacts = {
  configured: true,
  selector: all,
  organizationActive: true,
  moduleEffective: true,
}
const resolveDestination = (
  changes: Partial<DestinationFacts> = {},
  deploymentRules: readonly Rule[] = [],
  entry: RegistryEntry = definition,
  channel = 'slack',
) =>
  resolveOrganizationDestination({
    typeKey: 'sample.event',
    type: entry,
    channel,
    destination: { ...destination, ...changes },
    deploymentRules,
  })

describe('user notification resolution', () => {
  it.each([
    [{ organizationActive: false, member: false, moduleReadable: false }, 'organization_inactive'],
    [{ organizationActive: true, member: false, moduleReadable: false }, 'not_member'],
    [{ organizationActive: true, member: true, moduleReadable: false }, 'module_denied'],
  ] as const)('denies access before rules: %s', (facts, reason) => {
    expect(resolve([], [], [], facts)).toEqual({ admitted: false, reason })
  })

  it.each([
    [[rule(false, true)], [rule(true, true)], [user(true)], false, true, 'deployment', all],
    [[rule(false)], [rule(true, true)], [user(false)], true, true, 'organization', all],
    [[rule(false)], [rule(false)], [user(true)], true, false, 'user', all],
    [
      [rule(false, true, category), rule(true, false, type)],
      [],
      [user(false)],
      false,
      false,
      'user',
      all,
    ],
    [
      [rule(false, false, all), rule(true, false, category), rule(false, false, type)],
      [],
      [],
      false,
      false,
      'deployment',
      type,
    ],
    [
      [],
      [rule(false, false, category), rule(true, false, type)],
      [],
      true,
      false,
      'organization',
      type,
    ],
    [
      [],
      [],
      [user(false, all), user(true, category), user(false, type)],
      false,
      false,
      'user',
      type,
    ],
  ] as const)(
    'selects specificity before locks and values',
    (deployment, organization, users, enabled, locked, level, selector) => {
      const result = resolve(deployment, organization, users)
      expect(result.admitted).toBe(true)
      if (!result.admitted) return
      expect(result.inbox).toBe(true)
      expect(result.external).toEqual([
        { channel: 'email', enabled: true, locked: false, source: { level: 'type-default' } },
        { channel: 'slack', enabled, locked, source: { level, selector } },
      ])
    },
  )

  it('keeps Inbox when all external channels are off and never adds in_app', () => {
    const result = resolve([rule(false, true, all, 'email'), rule(false, true)])
    expect(result.admitted && result.inbox).toBe(true)
    expect(
      result.admitted && result.external.map(({ channel, enabled }) => [channel, enabled]),
    ).toEqual([
      ['email', false],
      ['slack', false],
    ])
  })

  it('fails closed on relevant invalid and ambiguous persisted rules, independent of row order', () => {
    for (const rules of [
      [rule(true, true, all, 'email')],
      [rule(true, false), rule(false, false)],
      [rule(false, false), rule(true, false)],
      [{ ...rule(true), enabled: 'yes' } as never],
    ]) {
      const result = resolve(rules)
      expect(result.admitted && result.inbox).toBe(true)
      if (!result.admitted) continue
      const channel = rules[0]?.channel
      expect(result.external.find((decision) => decision.channel === channel)?.enabled).toBe(false)
    }
  })

  it('ignores rules for an unrelated registered type', () => {
    const result = resolve([rule(false, true, { kind: 'type', value: 'other.event' })])
    expect(
      result.admitted && result.external.find((item) => item.channel === 'slack')?.enabled,
    ).toBe(true)
  })
})

describe('rule writes and collective destinations', () => {
  it.each([
    ['deployment', rule(true, true, all, 'email')],
    ['organization', rule(true, true, all, 'email')],
    ['user', rule(false, true)],
    ['deployment', rule(true, false, all, 'in_app')],
    ['deployment', rule(true, false, all, 'unknown')],
    ['deployment', rule(true, false, { kind: 'type', value: 'other.event' }, 'email')],
    ['deployment', rule(true, false, { kind: 'category', value: 'missing' })],
    ['deployment', rule(true, false, { kind: 'all', value: 'unexpected' } as never)],
    ['deployment', rule(true, false, { kind: 'type', value: 'sample.event\n' })],
  ] as const)('rejects invalid writes at %s', (level, invalid) => {
    expect(() => validateNotificationRule({ registry, level, rule: invalid })).toThrow()
  })

  it('preserves inherited selector scope when validating a rule', () => {
    const selector = Object.create({ kind: 'type', value: 'other.event' }) as Rule['selector']
    const validated = validateNotificationRule({
      registry,
      level: 'deployment',
      rule: rule(false, false, selector),
    })
    const deploymentRules = [rule(true), validated]
    const sample = resolve(deploymentRules)
    const target = resolveUserNotification({
      typeKey: 'other.event',
      type: other,
      access,
      deploymentRules,
      organizationRules: [],
      userRules: [],
    })
    expect(
      sample.admitted && sample.external.find((item) => item.channel === 'slack')?.enabled,
    ).toBe(true)
    expect(
      target.admitted && target.external.find((item) => item.channel === 'slack')?.enabled,
    ).toBe(false)
  })

  it('returns a detached immutable rule including its selector', () => {
    const selector = { kind: 'type' as const, value: 'sample.event' }
    const validated = validateNotificationRule({
      registry,
      level: 'organization',
      rule: rule(false, true, selector),
    })
    selector.value = 'other.event'
    expect(validated.selector).toEqual({ kind: 'type', value: 'sample.event' })
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.selector)).toBe(true)
  })

  it('permits explicit configuration despite an unlocked off default, but not a locked-off ceiling', () => {
    expect(resolveDestination({}, [rule(false)]).enabled).toBe(true)
    expect(resolveDestination({}, [rule(false, true)]).enabled).toBe(false)
    expect(
      resolveDestination({}, [rule(false, true, category), rule(true, false, type)]).enabled,
    ).toBe(true)
  })

  it('fails closed for malformed or ambiguous relevant destination rules', () => {
    expect(resolveDestination({}, [rule(true), rule(false)]).enabled).toBe(false)
    expect(resolveDestination({}, [{ ...rule(true), enabled: 'yes' } as never]).enabled).toBe(false)
  })

  it('requires opt-in, configuration, matching selector, access and declared external channel', () => {
    expect(resolveDestination().enabled).toBe(true)
    expect(resolveDestination({ configured: false }, [rule(true, true)]).enabled).toBe(false)
    expect(resolveDestination({ organizationActive: false }).enabled).toBe(false)
    expect(resolveDestination({ moduleEffective: false }).enabled).toBe(false)
    expect(resolveDestination({ selector: { kind: 'type', value: 'other.event' } }).enabled).toBe(
      false,
    )
    expect(resolveDestination({}, [], other).enabled).toBe(false)
    expect(resolveDestination({}, [], definition, 'in_app').enabled).toBe(false)
    expect(resolveDestination({}, [], definition, 'unknown').enabled).toBe(false)
  })
})

describe('attempt eligibility', () => {
  it('only permits unresolved pending admitted enabled declared user deliveries', () => {
    const resolution = resolve()
    const input = { resolution, channel: 'slack', status: 'pending' as const, resolved: false }
    expect(isUserDeliveryEligible(input)).toBe(true)
    for (const status of ['sent', 'failed', 'skipped'] as const)
      expect(isUserDeliveryEligible({ ...input, status })).toBe(false)
    expect(isUserDeliveryEligible({ ...input, resolved: true })).toBe(false)
    expect(isUserDeliveryEligible({ ...input, channel: 'in_app' })).toBe(false)
    expect(isUserDeliveryEligible({ ...input, channel: 'unknown' })).toBe(false)
    expect(isUserDeliveryEligible({ ...input, resolution: resolve([rule(false, true)]) })).toBe(
      false,
    )
    expect(
      isUserDeliveryEligible({
        ...input,
        resolution: resolve([], [], [], { ...access, member: false }),
      }),
    ).toBe(false)
  })
  it('only permits unresolved pending enabled collective deliveries', () => {
    const input = { resolution: resolveDestination(), status: 'pending' as const, resolved: false }
    expect(isOrganizationDeliveryEligible(input)).toBe(true)
    for (const status of ['sent', 'failed', 'skipped'] as const)
      expect(isOrganizationDeliveryEligible({ ...input, status })).toBe(false)
    expect(isOrganizationDeliveryEligible({ ...input, resolved: true })).toBe(false)
    expect(
      isOrganizationDeliveryEligible({
        ...input,
        resolution: resolveDestination({ configured: false }),
      }),
    ).toBe(false)
  })
})
