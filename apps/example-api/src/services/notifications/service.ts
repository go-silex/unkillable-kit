import { AppError } from '@kit/core'
import {
  type AccessFacts,
  type Json,
  parseNotificationParams,
  type Registry,
  type Rule,
  type SourceRef,
  type UserRule,
} from '@kit/notifications'
import type {
  AdmissionBatch,
  ConfiguredDestination,
  NotifyResult,
  ResolveInput,
  ResolveResult,
} from '@kit/notifications/repos'
import * as z from 'zod'
import { handoffDeliveries, type NotificationRuntimePorts, planDeliveries } from './delivery-plan'

export type { NotificationRuntimePorts } from './delivery-plan'

type NotifyInput<R extends Registry> = {
  [K in keyof R & string]: Readonly<{
    orgId: string
    type: K
    source: SourceRef
    userIds: readonly string[]
    actorId?: string
    params: z.input<R[K]['params']>
  }>
}[keyof R & string]

export type NotificationService<R extends Registry> = Readonly<{
  notify(input: NotifyInput<R>): Promise<NotifyResult>
  resolve(input: ResolveInput): Promise<ResolveResult>
}>

export type NotificationPersistencePorts = Readonly<{
  recipientAccess(input: {
    orgId: string
    userIds: readonly string[]
    moduleId?: string
  }): Promise<ReadonlyMap<string, AccessFacts>>
  rules(input: { orgId: string; userIds: readonly string[] }): Promise<
    Readonly<{
      deployment: readonly Rule[]
      organization: readonly Rule[]
      users: ReadonlyMap<string, readonly UserRule[]>
    }>
  >
  destinations(input: {
    orgId: string
    type: string
    moduleId?: string
  }): Promise<readonly ConfiguredDestination[]>
  admit(input: AdmissionBatch): Promise<NotifyResult>
  resolve(input: ResolveInput & { now: number }): Promise<ResolveResult>
}>

export type NotificationAppPorts = NotificationPersistencePorts & NotificationRuntimePorts

export type NotificationResolver = Readonly<{
  resolve(input: ResolveInput): Promise<ResolveResult>
}>

const identity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'))
const source = z.strictObject({
  kind: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !value.includes('\0')),
  id: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes('\0')),
})
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*(?![\s\S])/)
const notifySchema = z.strictObject({
  orgId: identity,
  type: key,
  source,
  userIds: z.array(identity),
  actorId: identity.optional(),
  params: z.unknown(),
})
const resolveSchema = z.strictObject({
  orgId: identity,
  source,
  types: z.array(key).optional(),
  userIds: z.array(identity).optional(),
})
const idSchema = z
  .string()
  .min(1)
  .max(254)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/)

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw AppError.validation('Invalid notifications input')
  return result.data
}

function time(now: () => number, deliveryDeadline: boolean): number {
  const value = now()
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (deliveryDeadline && !Number.isSafeInteger(value + 86_400_000))
  )
    throw AppError.validation('Invalid notifications input')
  return value
}

export function createNotificationResolver(input: {
  ports: Pick<NotificationPersistencePorts, 'resolve'>
  now: () => number
}): NotificationResolver {
  return {
    async resolve(raw) {
      const data = checked(resolveSchema, raw)
      return input.ports.resolve({ ...data, now: time(input.now, false) })
    },
  }
}

export function createNotificationService<const R extends Registry>(
  input: Readonly<{
    registry: R
    ports: NotificationAppPorts
    now: () => number
    newId: () => string
  }>,
): NotificationService<R> {
  const { registry, ports } = input
  const resolver = createNotificationResolver({ ports, now: input.now })
  return {
    async notify(raw) {
      const data = checked(notifySchema, raw)
      if (!Object.hasOwn(registry, data.type))
        throw AppError.validation('Invalid notifications input')
      const type = registry[data.type]
      if (!type) throw AppError.validation('Invalid notifications input')
      const params = parseNotificationParams(type, data.params) as Json
      const now = time(input.now, true)
      const userIds = [...new Set(data.userIds)].filter((id) => id !== data.actorId)
      // The policy resolver may seed missing system roles; validate every possible
      // generated identity before invoking it, not merely before admission.
      const ids = [checked(idSchema, input.newId())]
      const [rules, destinations] = await Promise.all([
        ports.rules({ orgId: data.orgId, userIds }),
        type.organizationDestinations
          ? ports.destinations({ orgId: data.orgId, type: data.type, moduleId: type.moduleId })
          : Promise.resolve([]),
      ])
      const capacity = userIds.length * (1 + type.channels.length) + destinations.length
      for (let i = 1; i < capacity; i++) ids.push(checked(idSchema, input.newId()))
      let next = 0
      const takeId = () => ids[next++]!
      const access = await ports.recipientAccess({
        orgId: data.orgId,
        userIds,
        moduleId: type.moduleId,
      })
      const { users, organizations } = planDeliveries({
        typeKey: data.type,
        type,
        userIds,
        access,
        rules,
        destinations,
        takeId,
      })
      const result = await ports.admit({
        orgId: data.orgId,
        type: data.type,
        moduleId: type.moduleId ?? null,
        source: data.source,
        params,
        now,
        users,
        organizations,
      })
      return handoffDeliveries(result, ports)
    },
    resolve: resolver.resolve,
  }
}
