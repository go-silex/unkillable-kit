import type { DeliveryRef } from '@kit/notifications'
import type { WorkerStringEnv } from './env.schema'

/**
 * Structural subset of CF Email Sending (ADR-0004) the kit's email port consumes. The runtime
 * binding type is the `SendEmail` global from `worker-configuration.d.ts`.
 */
type SendEmailBinding = {
  send: (msg: {
    to: string | string[]
    from: string | { email: string; name?: string }
    subject: string
    text?: string
    html?: string
  }) => Promise<{ messageId?: string } | undefined>
}

/**
 * Cloudflare Worker bindings + string env.
 * String keys SSoT: `./env.schema.ts` (Zod). Do not add string keys here only.
 */
export type Env = WorkerStringEnv & {
  DB: D1Database
  BUCKET: R2Bucket
  /** Optional send_email binding — required when EMAIL_TRANSPORT=cf. */
  EMAIL?: SendEmailBinding
  /** Optional demo queue binding (wrangler queues) — absent locally is ok. */
  DEMO_QUEUE?: Queue
  /** Wrangler [[workflows]] binding. Instance names are account-scoped / env-distinct. */
  FLOW_RUN: Workflow<{ runId: string; orgId: string }>
  /** Native owner of notification deliveries. */
  NOTIFICATION_DELIVERY: Workflow<DeliveryRef>
  /**
   * Wrangler [version_metadata] binding: the serving version's id, tag and timestamp. Its tag is
   * empty under `wrangler dev`; /health reports it as `versionTag` for Deploy verify.
   */
  CF_VERSION_METADATA?: WorkerVersionMetadata
}
