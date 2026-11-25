import type { KitD1Database, KitD1Statement } from '@kit/db'
import { apiKeyPrefix, hasApiKeyFormat, parseBearer, verifyApiKey } from '../keys'
import type { PlatformRole } from '../org-roles'
import { parseApiKeyScopes } from '../require-auth'
import { type SessionCookieInput, verifySessionCookie } from './cookie'
import {
  type Delegation,
  decodeImpersonation,
  decodeModules,
  flag,
  type Identity,
  type ImpersonationPermissions,
  identifier,
  integer,
  type Modules,
  type Organization,
  organization,
  resultRows,
  role,
  sessionIdentity,
  singleResult,
  text,
  unavailable,
} from './core-rows'
import { type Candidate, coreQueries, delegationQuery } from './core-sql'
import type { HostedPrincipalInput } from './hosted-principal'

export type CoreSnapshot = Readonly<{
  identity: Identity | null
  keyId: string | null
  platformRole: PlatformRole | null
  organization: Organization | null
  modules: Modules
  delegation: Delegation | null
  impersonationPermissions: ImpersonationPermissions | null
}>

type Load = {
  db: () => KitD1Database
  authorization?: string
  cookie?: SessionCookieInput
  hosted?: HostedPrincipalInput
  organizationId?: string
  impersonation?: boolean
  modules?: true
}

type Credentials = {
  candidate: Candidate | null
  delegationToken: string | null
  bearer: string | null
}
type Row = Record<string, unknown>
const EMPTY: CoreSnapshot = Object.freeze({
  identity: null,
  keyId: null,
  platformRole: null,
  organization: null,
  delegation: null,
  impersonationPermissions: null,
  modules: 'disabled',
})

async function credentials(input: Load): Promise<Credentials> {
  if (input.hosted)
    return {
      candidate: { kind: 'mcp', userId: input.hosted.userId },
      delegationToken: null,
      bearer: null,
    }
  const bearer = parseBearer(input.authorization)
  const token =
    input.cookie && (!bearer || input.impersonation)
      ? await verifySessionCookie(input.cookie)
      : null
  const delegationToken = input.impersonation ? token : null
  if (bearer)
    return {
      candidate: hasApiKeyFormat(bearer) ? { kind: 'api_key', prefix: apiKeyPrefix(bearer) } : null,
      delegationToken,
      bearer,
    }
  return { candidate: token ? { kind: 'session', token } : null, delegationToken, bearer }
}

async function readCore(input: Load, { candidate, delegationToken }: Credentials) {
  const db = input.db()
  if (!db.batch) throw unavailable()
  const statements: KitD1Statement[] = []
  function add(query: { sql: string; values: (string | null)[] }) {
    return statements.push(db.prepare(query.sql).bind(...query.values)) - 1
  }
  const queries =
    candidate &&
    coreQueries(candidate, input.organizationId, Boolean(delegationToken), input.modules === true)
  const coreIndex = queries ? add(queries.core) : -1
  const orgModuleIndex = queries?.modules ? add(queries.modules) : -1
  const delegationIndex = delegationToken ? add(delegationQuery(delegationToken)) : -1
  const batch = await db.batch(statements)
  if (!Array.isArray(batch) || batch.length !== statements.length) throw unavailable()
  return {
    row: coreIndex >= 0 ? singleResult(batch[coreIndex]) : null,
    delegationRow: delegationIndex >= 0 ? singleResult(batch[delegationIndex]) : null,
    moduleRows: orgModuleIndex >= 0 ? resultRows(batch[orgModuleIndex]) : [],
  }
}

async function identifyKey(
  row: Row,
  subject: string,
  bearer: string | null,
  now: number,
): Promise<Identity | null> {
  const hash = text(row.key_hash)
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw unavailable()
  if (!(bearer && (await verifyApiKey(bearer, hash)))) return null
  if (row.key_expiry !== null && integer(row.key_expiry) <= now) return null
  return Object.freeze({
    method: 'api_key',
    subject,
    organizationId: identifier(row.key_org),
    scopes: Object.freeze(parseApiKeyScopes(text(row.key_scopes))),
  })
}

function identify(
  row: Row,
  kind: Candidate['kind'],
  bearer: string | null,
  hosted: HostedPrincipalInput | undefined,
  now: number,
) {
  if (flag(row.disabled)) return null
  const subject = identifier(row.subject)
  switch (kind) {
    case 'session':
      return integer(row.session_expiry) < now
        ? null
        : sessionIdentity(subject, row.session_id, row.email)
    case 'api_key':
      return identifyKey(row, subject, bearer, now)
    case 'mcp': {
      const { grantId, clientId } = hosted ?? {}
      return Object.freeze({
        method: 'mcp' as const,
        subject,
        ...(grantId !== undefined ? { grantId, clientId } : {}),
      })
    }
  }
}

/** Fixed, bound reads on the primary binding, never on a D1 Sessions handle. */
export async function loadCore(input: Load): Promise<CoreSnapshot> {
  try {
    const verified = await credentials(input)
    const { candidate, delegationToken, bearer } = verified
    if (!(candidate || delegationToken)) return EMPTY
    const { row, delegationRow, moduleRows } = await readCore(input, verified)
    const now = Date.now()
    const { permissions, delegation } = decodeImpersonation(delegationRow, now)
    if (!(row && candidate)) return { ...EMPTY, delegation }
    const identity = await identify(row, candidate.kind, bearer, input.hosted, now)
    if (!identity) return { ...EMPTY, delegation }
    return {
      identity,
      delegation,
      impersonationPermissions: identity.method === 'session' ? permissions : null,
      keyId: identity.method === 'api_key' ? identifier(row.key_id) : null,
      platformRole: role(row.platform_role),
      organization:
        input.organizationId === undefined ? null : organization(row, row.membership_role),
      modules: input.modules ? decodeModules(moduleRows) : 'disabled',
    }
  } catch {
    // Driver and shape errors can carry SQL, binding values and raw rows. Never retain a cause.
    throw unavailable()
  }
}
