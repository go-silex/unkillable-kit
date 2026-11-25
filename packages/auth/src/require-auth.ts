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
