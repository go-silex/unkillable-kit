import type * as z from 'zod'
import type { NotificationDefinition, Registry, RegistryEntry } from './types'
import { validKey } from './validation'

const entries = new WeakSet<object>()

function validateChannels(
  channels: readonly string[],
  defaults: readonly string[],
  render: Record<PropertyKey, unknown>,
): void {
  if (
    channels.some(
      (channel) =>
        !validKey(channel, 64) || channel === 'in_app' || typeof render[channel] !== 'function',
    ) ||
    new Set(channels).size !== channels.length ||
    defaults.some((channel) => !channels.includes(channel)) ||
    new Set(defaults).size !== defaults.length
  )
    throw new TypeError('Invalid notification channels')
}

export function defineNotificationType<S extends z.ZodType, M extends object, L extends string>(
  definition: NotificationDefinition<S, M, L>,
): NotificationDefinition<S, M, L> & RegistryEntry {
  if (!definition || typeof definition !== 'object')
    throw new TypeError('Invalid notification definition')
  if ('mandatory' in definition) throw new TypeError('Mandatory channels are not supported')
  const {
    category,
    params,
    moduleId,
    organizationDestinations,
    channels: rawChannels,
    defaultOn,
    render: rawRender,
  } = definition
  if (
    !(validKey(category, 128) && params) ||
    typeof params.parse !== 'function' ||
    !Array.isArray(rawChannels) ||
    !Array.isArray(defaultOn) ||
    !rawRender ||
    typeof rawRender !== 'object'
  )
    throw new TypeError('Invalid notification definition')
  if (moduleId !== undefined && (typeof moduleId !== 'string' || !moduleId))
    throw new TypeError('Invalid module')
  if (organizationDestinations !== undefined && organizationDestinations !== true)
    throw new TypeError('Invalid destination opt-in')
  const channels = [...rawChannels]
  const defaults = [...defaultOn]
  const render: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(rawRender))
    render[key] = (rawRender as Record<PropertyKey, unknown>)[key]
  if (typeof render.in_app !== 'function') throw new TypeError('Invalid notification definition')
  validateChannels(channels, defaults, render)
  const result = Object.freeze({
    category,
    params,
    ...(moduleId === undefined ? {} : { moduleId }),
    ...(organizationDestinations === undefined ? {} : { organizationDestinations }),
    channels: Object.freeze(channels),
    defaultOn: Object.freeze(defaults),
    render: Object.freeze(render),
  })
  entries.add(result)
  return result as unknown as NotificationDefinition<S, M, L> & RegistryEntry
}

export function defineNotificationRegistry<const R extends Registry>(definitions: R): Readonly<R> {
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions))
    throw new TypeError('Invalid notification registry')
  const result: Record<string, RegistryEntry> = Object.create(null) as Record<string, RegistryEntry>
  for (const [key, value] of Object.entries(definitions)) {
    if (!(validKey(key, 128) && value) || typeof value !== 'object' || !entries.has(value))
      throw new TypeError('Invalid notification registry entry')
    result[key] = value
  }
  return Object.freeze(result) as Readonly<R>
}
