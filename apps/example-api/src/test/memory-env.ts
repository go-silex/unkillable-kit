/**
 * SQLite-backed D1-compatible binding for integration tests.
 * better-sqlite3 works under Vitest (Node). Drizzle D1 driver needs bind/all/raw/run.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteD1, type SqliteD1 } from '@kit/db/testing'
import type { DeliveryRef } from '@kit/notifications'
import Database from 'better-sqlite3'
import { onTestFinished } from 'vitest'
import { createMemoryNotificationWorkflow } from './memory-notification-workflow'

const __dirname = dirname(fileURLToPath(import.meta.url))

function applyMigrations(sqlite: Database.Database, through?: string) {
  const migDir = join(__dirname, '../../migrations')
  // Same order as Wrangler: all *.sql lexical
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (through && !files.includes(through)) {
    throw new Error(`createMemoryEnv through=${through} is not a migration file`)
  }
  for (const name of files) {
    sqlite.exec(readFileSync(join(migDir, name), 'utf8'))
    if (through && name === through) break
  }
}

function makeR2() {
  const store = new Map<string, { body: string }>()
  return {
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      let body = ''
      if (typeof value === 'string') body = value
      else if (value instanceof ArrayBuffer) body = new TextDecoder().decode(value)
      else if (ArrayBuffer.isView(value)) {
        body = new TextDecoder().decode(
          value instanceof Uint8Array ? value : new Uint8Array(value.buffer),
        )
      } else body = String(value)
      store.set(key, { body })
      return { key }
    },
    async get(key: string) {
      const v = store.get(key)
      if (!v) return null
      return {
        key,
        body: new Blob([v.body]).stream(),
        async text() {
          return v.body
        },
      }
    },
    async delete(key: string | string[]) {
      if (Array.isArray(key)) for (const k of key) store.delete(k)
      else store.delete(key)
    },
    _keys() {
      return [...store.keys()]
    },
  }
}

type FlowRunParams = { runId: string; orgId: string }

/**
 * WorkflowInstance double. `Env.FLOW_RUN` is a real `Workflow<FlowRunParams>`, so the
 * fixture must answer the whole surface — tests that stub `create`/`get` return this.
 * Members the kit never calls throw rather than answering a fake success.
 */
export function workflowInstanceStub(
  id: string,
  state: InstanceStatus['status'] = 'queued',
): WorkflowInstance & {
  sent: Array<{ type: string; payload: unknown }>
  terminated: number
} {
  const sent: Array<{ type: string; payload: unknown }> = []
  let terminated = 0
  return {
    id,
    async status() {
      return { status: state }
    },
    async pause() {
      throw new Error('workflowInstanceStub: pause() is not implemented')
    },
    async resume() {
      throw new Error('workflowInstanceStub: resume() is not implemented')
    },
    get terminated() {
      return terminated
    },
    async terminate() {
      terminated += 1
    },
    async restart() {
      throw new Error('workflowInstanceStub: restart() is not implemented')
    },
    async delete() {
      throw new Error('workflowInstanceStub: delete() is not implemented')
    },
    async subscribe() {
      throw new Error('workflowInstanceStub: subscribe() is not implemented')
    },
    sent,
    async sendEvent(event: { type: string; payload: unknown }) {
      sent.push(event)
    },
  }
}

export type EnvLike = {
  DB: SqliteD1
  BUCKET: ReturnType<typeof makeR2>
  /** Same type as the Worker binding, so services typecheck against `Pick<Env, 'FLOW_RUN'>`. */
  FLOW_RUN: Workflow<FlowRunParams>
  NOTIFICATION_DELIVERY: Workflow<DeliveryRef>
  /** Absent unless a test plays a deployed version (`wrangler deploy --tag`). */
  CF_VERSION_METADATA?: WorkerVersionMetadata
  ENVIRONMENT?: string
  CORS_ORIGINS?: string
  DEMO_USER_EMAIL?: string
  SMTP_HOST?: string
  SMTP_PORT?: string
  SESSION_COOKIE_NAME?: string
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  ALLOW_PUBLIC_SIGNUP?: string
  FLOW_ALLOWED_MODELS?: string
  NOTIFICATIONS_RETENTION_DAYS?: string
  NOTIFICATION_DELIVERIES_RETENTION_DAYS?: string
}

/** Fresh in-memory SQLite + R2 for each test (same createApp entry as Worker). */
export function createMemoryEnv(
  overrides?: Partial<EnvLike> & { through?: string },
): EnvLike & { close(): void } {
  const { through, ...envOverrides } = overrides ?? {}
  const sqlite = new Database(':memory:')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    sqlite.close()
  }
  onTestFinished(close)
  // Enforce composite FKs (e.g. flow_runs.plan_id+org_id) in tests — SQLite default is OFF.
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite, through)
  return {
    DB: createSqliteD1(sqlite),
    BUCKET: makeR2(),
    FLOW_RUN: {
      create: async (opts) => workflowInstanceStub(opts?.id ?? 'wf_test'),
      // Unused by the kit: a silent success here would hide a new call site.
      async get() {
        throw new Error('createMemoryEnv: FLOW_RUN.get is not implemented — stub it in the test')
      },
      async createBatch() {
        throw new Error(
          'createMemoryEnv: FLOW_RUN.createBatch is not implemented — stub it in the test',
        )
      },
      async deleteBatch() {
        throw new Error(
          'createMemoryEnv: FLOW_RUN.deleteBatch is not implemented — stub it in the test',
        )
      },
    },
    NOTIFICATION_DELIVERY: createMemoryNotificationWorkflow(workflowInstanceStub),
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32!!',
    BETTER_AUTH_URL: 'http://localhost:8787',
    ENVIRONMENT: 'test',
    DEMO_USER_EMAIL: 'demo@kit.local',
    ...envOverrides,
    close,
  }
}
