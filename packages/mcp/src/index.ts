/**
 * @kit/mcp — agent-facing tool catalogue + public errors.
 * Tool catalogue is forked from flows `createToolRegistry` by decision (ADR-0005 D6 amendment):
 * executable tools here, authority classification there. Unifying is a promote that replaces both
 * callers — never a third factory sitting beside them (M-04). `effect` / `auth` here stay
 * descriptive; the authority-bearing name is `grantClass` in `@kit/flows` (Roxabi/roxabi-boilerplate-cf#243).
 */

import { parseBearer } from '@kit/auth'
import type { WhoamiStatus } from './agentWire'
import type { McpIdentity } from './identity'
import { isLoopbackHostname } from './loopback-host'
import { meResponseSchema } from './schemas'

export {
  DEFAULT_EXAMPLE_TOOL_NAMES,
  type DefaultExampleToolName,
  INPUT_BUDGET,
  MCP_BEARER_HEADER,
  MCP_BEARER_PREFIX,
  MCP_ENV_KEYS,
  PUBLIC_TOOL_ERROR_CODES,
  PUBLIC_TOOL_ERROR_MESSAGES,
  type PublicToolErrorCode,
  WHOAMI_STATUS,
  type WhoamiStatus,
} from './agentWire'
export { type BudgetFailure, type BudgetOk, checkInputBudget } from './budget'
export {
  assertToolsMatchAllowlist,
  createToolCatalogue,
  type ToolAuthHint,
  type ToolCatalogue,
  type ToolContext,
  type ToolDef,
  type ToolEffect,
  type ToolRefusal,
  type ToolServer,
  toolRefusal,
} from './catalogue'
export type { McpIdentity, McpIdentityPort, McpIdentityResolveInput } from './identity'
export {
  isPublicToolErrorCode,
  PublicToolError,
  type PublicToolErrorBody,
  stableJsonWire,
  toPublicToolError,
} from './publicErrors'
export {
  type MeResponse,
  meResponseSchema,
  type PingResult,
  pingResultSchema,
  type WhoamiResultParsed,
  whoamiResultSchema,
} from './schemas'

function asSkKey(token: string | null | undefined): string | null {
  if (!token?.startsWith('sk_')) return null
  return token
}

export function extractBearerFromEnv(env: Record<string, string | undefined>): string | null {
  const auth = env.AUTHORIZATION?.trim()
  if (auth) {
    // Accept bare sk_… or full "Bearer sk_…" without double-prefixing.
    const fromBearer = parseBearer(auth) ?? parseBearer(`Bearer ${auth}`)
    const sk = asSkKey(fromBearer)
    if (sk) return sk
  }
  return asSkKey(env.API_KEY)
}

export async function handlePing(): Promise<{ ok: true }> {
  return { ok: true }
}

export type WhoamiResult = {
  keyPresent: boolean
  verified: boolean
  /** Subject from GET /api/me (stdio) or MCP userId (hosted); never key material. */
  subject: string | null
  /** Domain channel — machine-readable fail reason when not verified. */
  status: WhoamiStatus
  /** Hosted MCP identity; omitted on the stdio sk_ path. */
  userId?: string | null
  email?: string | null
}

export type WhoamiFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type WhoamiOptions = {
  /** Base URL of the kit API, e.g. http://127.0.0.1:8787 — no path. */
  apiBaseUrl?: string | null
  /** Default 3000ms. */
  timeoutMs?: number
  /**
   * Hostnames allowed for SSRF protection (exact host match).
   * Defaults to loopback. Non-loopback names require `allowNonLocalHosts`.
   */
  allowedHosts?: string[]
  /** Break-glass: send `sk_` to non-loopback `allowedHosts`. Default false. */
  allowNonLocalHosts?: boolean
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetch?: WhoamiFetch
}

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]']

function isAllowedApiBase(apiBaseUrl: string, allowedHosts: string[]): URL | null {
  let url: URL
  try {
    url = new URL(apiBaseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (!allowedHosts.some((h) => h.toLowerCase() === host)) return null
  return url
}

/**
 * Verify Bearer sk_ against GET {apiBaseUrl}/api/me.
 * Never returns key material. Fail-closed on network/auth/config errors (does not throw).
 * Domain outcomes stay on WhoamiResult.status (not PublicToolError).
 */
export async function handleWhoami(
  apiKey: string | null,
  opts?: WhoamiOptions,
): Promise<WhoamiResult> {
  if (!apiKey) {
    return { keyPresent: false, verified: false, subject: null, status: 'missing_key' }
  }

  const base = opts?.apiBaseUrl?.trim()
  if (!base) {
    return { keyPresent: true, verified: false, subject: null, status: 'bad_config' }
  }

  const allowed = opts?.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
  if (allowed.some((h) => !isLoopbackHostname(h)) && !opts?.allowNonLocalHosts) {
    return { keyPresent: true, verified: false, subject: null, status: 'bad_config' }
  }
  const url = isAllowedApiBase(base, allowed)
  if (!url) {
    return { keyPresent: true, verified: false, subject: null, status: 'bad_config' }
  }

  const meUrl = new URL('/api/me', url).toString()
  const timeoutMs = opts?.timeoutMs ?? 3000
  const fetchImpl = opts?.fetch ?? (globalThis.fetch as WhoamiFetch)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  try {
    const res = await fetchImpl(meUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: ac.signal,
    })
    if (res.status === 401 || res.status === 403) {
      return { keyPresent: true, verified: false, subject: null, status: 'unauthorized' }
    }
    if (!res.ok) {
      return { keyPresent: true, verified: false, subject: null, status: 'unreachable' }
    }
    const body: unknown = await res.json()
    const parsed = meResponseSchema.safeParse(body)
    if (!parsed.success) {
      return { keyPresent: true, verified: false, subject: null, status: 'invalid_response' }
    }
    return {
      keyPresent: true,
      verified: true,
      subject: parsed.data.subject,
      status: 'ok',
    }
  } catch {
    return { keyPresent: true, verified: false, subject: null, status: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Hosted whoami from the Worker MCP token props.
 * `verified` ⇔ MCP identity present. Never calls /api/me, never returns sk_.
 */
export async function handleWhoamiFromMcpIdentity(
  identity: McpIdentity | null | undefined,
): Promise<WhoamiResult> {
  const userId = identity?.userId?.trim()
  if (!userId) {
    return {
      keyPresent: false,
      verified: false,
      subject: null,
      status: 'missing_identity',
      userId: null,
      email: null,
    }
  }
  const email = identity?.email?.trim() || null
  return {
    keyPresent: false,
    verified: true,
    subject: userId,
    status: 'ok',
    userId,
    email,
  }
}
