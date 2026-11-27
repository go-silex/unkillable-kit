import type * as z from 'zod'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type SourceRef = Readonly<{ kind: string; id: string }>
export type Selector =
  | Readonly<{ kind: 'type' | 'category'; value: string }>
  | Readonly<{ kind: 'all' }>
export type InboxContent = Readonly<{ title: string; body: string; href: string }>
export type EmailContent = Readonly<{ subject: string; text: string; html?: string }>
export type RenderInput<P, L extends string> = Readonly<{
  orgId: string
  source: SourceRef
  params: P
  locale: L
  href: string
}>
export type NotificationDefinition<
  S extends z.ZodType,
  M extends object,
  L extends string,
> = Readonly<{
  category: string
  moduleId?: string
  params: S
  channels: readonly (keyof M & string)[]
  defaultOn: readonly (keyof M & string)[]
  organizationDestinations?: true
  render: { in_app(input: RenderInput<z.output<S>, L>): InboxContent } & {
    [C in keyof M]?: (input: RenderInput<z.output<S>, L>) => M[C]
  }
}>

declare const notificationDefinition: unique symbol
export interface RegistryEntry {
  readonly [notificationDefinition]: true
  readonly params: z.ZodType
  readonly category: string
  readonly moduleId?: string
  readonly channels: readonly string[]
  readonly defaultOn: readonly string[]
  readonly organizationDestinations?: true
}
export type Registry = Readonly<Record<string, RegistryEntry>>
export type Rule = Readonly<{
  selector: Selector
  channel: string
  enabled: boolean
  locked: boolean
}>
export type UserRule = Omit<Rule, 'locked'> & Readonly<{ locked: false }>
export type AccessFacts = Readonly<{
  organizationActive: boolean
  member: boolean
  moduleReadable: boolean
}>
export type RuleSource =
  | Readonly<{ level: 'deployment' | 'organization' | 'user'; selector: Selector }>
  | Readonly<{ level: 'type-default' }>
export type ExternalDecision = Readonly<{
  channel: string
  enabled: boolean
  locked: boolean
  source: RuleSource
}>
export type UserResolution =
  | Readonly<{ admitted: false; reason: 'organization_inactive' | 'not_member' | 'module_denied' }>
  | Readonly<{ admitted: true; inbox: true; external: readonly ExternalDecision[] }>
export type DestinationFacts = Readonly<{
  configured: boolean
  selector: Selector
  organizationActive: boolean
  moduleEffective: boolean
}>
export type ChannelResult =
  | Readonly<{ status: 'sent' }>
  | Readonly<{ status: 'retryable'; code: string; retryAfterSeconds?: number }>
  | Readonly<{ status: 'permanent'; code: string }>
export type Channel<Input extends { orgId: string }> = Readonly<{
  send(input: Input): Promise<ChannelResult>
}>
export type AddressResolution<A> =
  | Readonly<{ status: 'ready'; address: A }>
  | Readonly<{ status: 'unavailable'; code: string }>
  | Readonly<{ status: 'retryable'; code: string; retryAfterSeconds?: number }>
export type DeliveryState = 'pending' | 'sent' | 'failed' | 'skipped'
export type OrganizationDestinationResolution = Readonly<{ enabled: boolean; reason: string }>
