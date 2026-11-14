import { AppError } from '@kit/core'
import { apiKeyPrefix, parseBearer, verifyApiKey } from './keys'
import type { SessionPort } from './session-port'

export type AuthMethod = 'session' | 'api_key'
export type ApiKeyScope = 'read' | 'write' | 'admin'

/** Unknown or malformed stored values grant no scopes. */
export function parseApiKeyScopes(value: string): ApiKeyScope[] {
  if (typeof value !== 'string' || !value) return []
  const scopes = value.split(',')
  if (scopes.some((scope) => scope !== 'read' && scope !== 'write' && scope !== 'admin')) {
    return []
  }
  return scopes as ApiKeyScope[]
}

/** API-key scopes narrow access independently; sessions remain governed by existing policy. */
export function allowsApiKeyScope(identity: AuthIdentity, requiredScope: ApiKeyScope): boolean {
  return identity.method === 'session' || identity.scopes.includes(requiredScope)
}

export type SessionAuthIdentity = {
  subject: string
  method: 'session'
  sessionId: string
}

/** Authenticated Bearer sk_ identity — always org-bound (ADR-0003 D11). */
export type ApiKeyAuthIdentity = {
  subject: string
  method: 'api_key'
  organizationId: string
  scopes: ApiKeyScope[]
}

export type AuthIdentity = SessionAuthIdentity | ApiKeyAuthIdentity

/** Row shape from storage lookup; org may be absent until package runtime rejects it (D11). */
export type ApiKeyRecord = {
  subject: string
  keyHash: string
  revokedAt: number | null
  expiresAt: number | null
  organizationId?: string | null
  scopes: string
}

export type DualAuthPorts = {
  /** Full request headers for BA getSession (preferred over cookie-only). */
  headers?: Headers
  /** Required — apps inject createBetterAuthSessionPort (ADR-0002 BA-only). */
  sessions: SessionPort
  isAccountActive: (subject: string) => Promise<boolean>
  findApiKeyByPrefix: (prefix: string) => Promise<ApiKeyRecord | null>
}

/**
 * ADR-0003 D11 — after credential verification, org id must be non-empty.
 * Returns normalized id or null (missing, null, blank, whitespace-only).
 */
export function normalizeApiKeyOrganizationId(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function requireActiveAccount(ports: DualAuthPorts, subject: string): Promise<void> {
  let active: boolean
  try {
    active = await ports.isAccountActive(subject)
  } catch {
    throw AppError.unauthorized()
  }
  if (active !== true) throw AppError.unauthorized()
}

/**
 * Pure dual-path auth: Bearer sk_ or session cookie.
 * Bearer wins when both are present.
 */
export async function resolveDualAuth(
  authorization: string | null | undefined,
  cookieHeader: string | null | undefined,
  ports: DualAuthPorts,
): Promise<AuthIdentity | null> {
  const sessions = ports.sessions
  const bearer = parseBearer(authorization)
  if (bearer) {
    let prefix: string
    try {
      prefix = apiKeyPrefix(bearer)
    } catch {
      throw AppError.unauthorized()
    }
    const row = await ports.findApiKeyByPrefix(prefix)
    if (!row || row.revokedAt != null) throw AppError.unauthorized()
    if (row.expiresAt != null && row.expiresAt <= Date.now()) throw AppError.unauthorized()
    const ok = await verifyApiKey(bearer, row.keyHash)
    if (!ok) throw AppError.unauthorized()
    // ADR-0003 D11 — subject-global / unbound keys are forbidden unconditionally.
    const organizationId = normalizeApiKeyOrganizationId(row.organizationId)
    if (!organizationId) {
      throw AppError.unauthorized()
    }
    await requireActiveAccount(ports, row.subject)
    return {
      subject: row.subject,
      method: 'api_key',
      organizationId,
      scopes: parseApiKeyScopes(row.scopes),
    }
  }

  const payload = await sessions.resolveSession({
    cookieHeader,
    headers: ports.headers,
  })
  if (payload) return { subject: payload.sub, method: 'session', sessionId: payload.sessionId }

  return null
}

export type RequireAuthContext = {
  req: {
    header: (name: string) => string | undefined
    /** Hono raw Request — used to forward Headers to BA getSession. */
    raw?: { headers: Headers }
  }
  set: (
    key: 'subject' | 'authMethod' | 'keyOrganizationId' | 'sessionId' | 'keyScopes',
    value: string | ApiKeyScope[],
  ) => void
}

export function createRequireAuth<C extends RequireAuthContext>(
  getPorts: (c: C) => DualAuthPorts | Promise<DualAuthPorts>,
): (c: C, next: () => Promise<void>) => Promise<void> {
  return async (c, next) => {
    const ports = await getPorts(c)
    const cookieHeader = c.req.header('cookie') ?? null
    const headers =
      ports.headers ?? (c.req.raw?.headers ? new Headers(c.req.raw.headers) : undefined)
    const auth = await resolveDualAuth(c.req.header('authorization') ?? null, cookieHeader, {
      ...ports,
      headers,
    })
    if (!auth) throw AppError.unauthorized()
    c.set('subject', auth.subject)
    c.set('authMethod', auth.method)
    if (auth.method === 'api_key') {
      c.set('keyOrganizationId', auth.organizationId)
      c.set('keyScopes', auth.scopes)
    } else {
      c.set('sessionId', auth.sessionId)
    }
    await next()
  }
}
