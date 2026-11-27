import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  defineNotificationRegistry,
  defineNotificationType,
  isOrganizationDeliveryEligible,
  isUserDeliveryEligible,
  type Rule,
  resolveOrganizationDestination,
  resolveUserNotification,
} from './index'

const params = z.strictObject({})
type Messages = { email: { subject: string; text: string }; slack: { text: string } }
const registry = defineNotificationRegistry({
  'sample.event': defineNotificationType<typeof params, Messages, 'en'>({
    category: 'sample',
    params,
    channels: ['email', 'slack'],
    defaultOn: ['email', 'slack'],
    organizationDestinations: true,
    render: {
      in_app: ({ href }) => ({ title: '', body: '', href }),
      email: () => ({ subject: '', text: '' }),
      slack: () => ({ text: '' }),
    },
  }),
})
const type = registry['sample.event']
const all = { kind: 'all' } as const
const access = { organizationActive: true, member: true, moduleReadable: true }

const changingEmailRule = (): Rule => {
  let reads = 0
  return {
    selector: all,
    channel: 'email',
    locked: true,
    get enabled() {
      return ++reads >= 3
    },
  }
}

describe('persisted rule snapshots', () => {
  it('does not turn a changing locked-off email rule into an eligible user delivery', () => {
    const resolution = resolveUserNotification({
      typeKey: 'sample.event',
      type,
      access,
      deploymentRules: [changingEmailRule()],
      organizationRules: [],
      userRules: [{ selector: all, channel: 'email', enabled: false, locked: false }],
    })
    expect(resolution.admitted && resolution.inbox).toBe(true)
    expect(
      resolution.admitted && resolution.external.find((item) => item.channel === 'email')?.enabled,
    ).toBe(false)
    expect(
      isUserDeliveryEligible({ resolution, channel: 'email', status: 'pending', resolved: false }),
    ).toBe(false)
  })

  it('does not let a changing email rule bypass the collective locked-off ceiling', () => {
    const resolution = resolveOrganizationDestination({
      typeKey: 'sample.event',
      type,
      channel: 'email',
      destination: {
        configured: true,
        selector: all,
        organizationActive: true,
        moduleEffective: true,
      },
      deploymentRules: [changingEmailRule()],
    })
    expect(resolution.enabled).toBe(false)
    expect(isOrganizationDeliveryEligible({ resolution, status: 'pending', resolved: false })).toBe(
      false,
    )
  })

  it('uses one channel snapshot rather than applying a changing rule to multiple channels', () => {
    let reads = 0
    const changingChannel: Rule = {
      selector: all,
      enabled: false,
      locked: true,
      get channel() {
        return ++reads === 1 ? 'email' : 'slack'
      },
    }
    const resolution = resolveUserNotification({
      typeKey: 'sample.event',
      type,
      access,
      deploymentRules: [changingChannel],
      organizationRules: [],
      userRules: [],
    })
    expect(
      resolution.admitted && resolution.external.map(({ channel, enabled }) => [channel, enabled]),
    ).toEqual([
      ['email', false],
      ['slack', true],
    ])
  })
})

describe('destination selector snapshots', () => {
  it('does not replace a nonmatching destination selector with all during resolution', () => {
    let reads = 0
    const destination = {
      configured: true,
      organizationActive: true,
      moduleEffective: true,
      get selector() {
        return ++reads === 1 ? { kind: 'type' as const, value: 'other.event' } : all
      },
    }
    const resolution = resolveOrganizationDestination({
      typeKey: 'sample.event',
      type,
      channel: 'email',
      destination,
      deploymentRules: [],
    })
    expect(resolution.enabled).toBe(false)
    expect(isOrganizationDeliveryEligible({ resolution, status: 'pending', resolved: false })).toBe(
      false,
    )
  })

  it('does not broaden a nonmatching selector whose kind changes during resolution', () => {
    let reads = 0
    const selector = {
      value: 'other.event',
      get kind(): 'type' | 'all' {
        return ++reads <= 2 ? 'type' : 'all'
      },
    }
    const resolution = resolveOrganizationDestination({
      typeKey: 'sample.event',
      type,
      channel: 'email',
      destination: {
        configured: true,
        organizationActive: true,
        moduleEffective: true,
        selector: selector as Rule['selector'],
      },
      deploymentRules: [],
    })
    expect(resolution.enabled).toBe(false)
    expect(isOrganizationDeliveryEligible({ resolution, status: 'pending', resolved: false })).toBe(
      false,
    )
  })
})
