import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'
import {
  type Channel,
  defineNotificationRegistry,
  defineNotificationType,
  parseNotificationParams,
  resolveUserNotification,
} from './index'

const schema = z.strictObject({
  title: z.string(),
  nested: z.array(z.strictObject({ count: z.number() })),
})
type Messages = { email: { subject: string; text: string }; webhook: { payload: string } }
const base = {
  category: 'sample',
  params: schema,
  channels: ['email'] as (keyof Messages)[],
  defaultOn: ['email'] as (keyof Messages)[],
  render: {
    in_app: ({ params, href }: { params: z.output<typeof schema>; href: string }) => ({
      title: params.title,
      body: '',
      href,
    }),
    email: ({ params }: { params: z.output<typeof schema> }) => ({
      subject: params.title,
      text: params.title,
    }),
  },
}
const make = () => defineNotificationType<typeof schema, Messages, 'en'>(base)

describe('registry construction', () => {
  it('detaches and freezes declared metadata from mutable caller input', () => {
    const channels = ['email'] as (keyof Messages)[]
    const defaults = ['email'] as (keyof Messages)[]
    const entry = defineNotificationType<typeof schema, Messages, 'en'>({
      ...base,
      channels,
      defaultOn: defaults,
    })
    const declarations = { 'sample.event': entry }
    const registry = defineNotificationRegistry(declarations)
    channels.push('webhook')
    defaults.pop()
    expect(registry['sample.event'].channels).toEqual(['email'])
    expect(registry['sample.event'].defaultOn).toEqual(['email'])
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry['sample.event'].channels)).toBe(true)
    expect(Object.isFrozen(registry['sample.event'].defaultOn)).toBe(true)
  })

  it('preserves inherited definition facts used for access and parameter validation', () => {
    const inherited = Object.create({
      category: 'sample',
      params: schema,
      moduleId: 'work',
    }) as typeof base & { moduleId: string }
    Object.assign(inherited, {
      channels: base.channels,
      defaultOn: base.defaultOn,
      render: base.render,
    })
    const entry = defineNotificationType<typeof schema, Messages, 'en'>(inherited)
    const registry = defineNotificationRegistry({ 'sample.event': entry })
    const registered = registry['sample.event']
    const moduleReadable = registered.moduleId === undefined
    expect(
      resolveUserNotification({
        typeKey: 'sample.event',
        type: registered,
        access: { organizationActive: true, member: true, moduleReadable },
        deploymentRules: [],
        organizationRules: [],
        userRules: [],
      }),
    ).toEqual({ admitted: false, reason: 'module_denied' })
    expect(registered.category).toBe('sample')
    expect(parseNotificationParams(registered, { title: 'allowed', nested: [] })).toEqual({
      title: 'allowed',
      nested: [],
    })
    expect(() =>
      parseNotificationParams(registered, { title: 'bad', nested: [], extra: true }),
    ).toThrow()
  })

  it('requires an own renderer for constructor while allowing an explicitly declared one', () => {
    const declaration = {
      ...base,
      channels: ['constructor'],
      defaultOn: ['constructor'],
      render: { in_app: base.render.in_app },
    }
    expect(() => defineNotificationType(declaration as never)).toThrow()
    const entry = defineNotificationType({
      ...declaration,
      render: { ...declaration.render, constructor: () => ({ text: 'declared' }) },
    } as never)
    expect(entry.channels).toEqual(['constructor'])
    expect((entry.render as Record<string, () => unknown>).constructor()).toEqual({
      text: 'declared',
    })
  })

  it.each(['', 'A', '1a', 'é', 'a\n', 'a\r', `a${'x'.repeat(128)}`])(
    'rejects invalid type key %j',
    (key) => {
      expect(() => defineNotificationRegistry({ [key]: make() })).toThrow()
    },
  )
  it('accepts ASCII type and category keys at their maximum length', () => {
    const key = `a${'x'.repeat(127)}`
    const entry = defineNotificationType<typeof schema, Messages, 'en'>({ ...base, category: key })
    expect(defineNotificationRegistry({ [key]: entry })[key]?.category).toBe(key)
  })
  it.each(['', 'A', 'é', 'a\n', `a${'x'.repeat(128)}`])(
    'rejects invalid category %j',
    (category) => {
      expect(() => defineNotificationType({ ...base, category } as never)).toThrow()
    },
  )
  it.each(['', 'A', 'é', 'a\n', `a${'x'.repeat(64)}`])('rejects invalid channel %j', (channel) => {
    expect(() =>
      defineNotificationType({
        ...base,
        channels: [channel],
        defaultOn: [],
        render: { ...base.render, [channel]: () => ({}) },
      } as never),
    ).toThrow()
  })
  it('accepts a maximum-length channel and requires real renderers', () => {
    const channel = `a${'x'.repeat(63)}`
    const entry = defineNotificationType({
      ...base,
      channels: [channel],
      defaultOn: [channel],
      render: { ...base.render, [channel]: () => ({}) },
    } as never)
    expect(entry.channels).toEqual([channel])
  })
  it.each([
    { ...base, channels: ['email', 'email'] },
    { ...base, channels: ['in_app'] },
    { ...base, defaultOn: ['in_app'] },
    { ...base, defaultOn: ['webhook'] },
    { ...base, render: { email: base.render.email } },
    { ...base, render: { in_app: base.render.in_app } },
    { ...base, mandatory: true },
    { ...base, channels: 'email' },
  ])('rejects invalid JavaScript declarations', (invalid) => {
    expect(() => defineNotificationType(invalid as never)).toThrow()
  })
  it('rejects forged registry entries', () => {
    expect(() => defineNotificationRegistry({ 'sample.event': base } as never)).toThrow()
  })
})

describe('parameter validation', () => {
  it('round trips localized JSON and recursively freezes the parsed result', () => {
    const parsed = parseNotificationParams(make(), { title: 'Équipe 東京', nested: [{ count: 2 }] })
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.nested)).toBe(true)
    expect(Object.isFrozen(parsed.nested[0])).toBe(true)
  })
  it('rejects invalid, cyclic and non-JSON values rather than silently losing data', () => {
    const any = { params: z.unknown() }
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      { x: undefined },
      [undefined],
      cycle,
    ]) {
      expect(() => parseNotificationParams(any, value)).toThrow()
    }
    expect(() => parseNotificationParams(make(), { title: 'x', nested: [], extra: true })).toThrow()
  })
  it('rejects schema outputs that cannot survive JSON revalidation', () => {
    const type = { params: z.string().transform((value) => new Date(value)) }
    expect(() => parseNotificationParams(type, '2024-01-01')).toThrow()
  })
  it('preserves consumer parameter and provider channel types', () => {
    const result = parseNotificationParams(make(), { title: 'x', nested: [] })
    expectTypeOf(result).toEqualTypeOf<z.output<typeof schema>>()
    expectTypeOf<
      Parameters<Channel<{ orgId: string; payload: number }>['send']>[0]
    >().toEqualTypeOf<{ orgId: string; payload: number }>()
  })
})
