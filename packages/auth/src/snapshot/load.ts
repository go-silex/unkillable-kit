import type { KitD1Database, KitD1Statement } from '@kit/db'
import { apiKeyPrefix, parseBearer, verifyApiKey } from '../keys'
import type { OrgContextRecord, PlatformRole } from '../org-roles'
import { normalizeApiKeyOrganizationId, parseApiKeyScopes } from '../require-auth'
import { type SessionCookieInput, verifySessionCookie } from './cookie'
import {
  type AuthorizationFact,
  type AuthorizationRow,
  type CompiledFact,
  compiledAuthorizationFact,
  MAX_FACTS,
} from './facts'
import {
  type DelegationSnapshot,
  decodeDelegation,
  EMPTY_ROWS,
  expiry,
  type FactResult,
  type Identity,
  organization,
  productRows,
  requiredString,
  role,
  sessionIdentity,
  singleResult,
  unavailable,
} from './rows'
import {
  type Candidate,
  candidateQuery,
  coreQuery,
  delegationQuery,
  withDelegationCandidate,
} from './sql'

export type RequestSnapshot = Readonly<{
  identity: Identity | null
  platformRole: PlatformRole | null
  organization: Readonly<OrgContextRecord> | null
  delegation: DelegationSnapshot | null
  /** Raw, private data: the calling adapter alone decides if or when it may decode. */
  rows(fact: AuthorizationFact<unknown>): readonly AuthorizationRow[]
}>

type LoadInput = {
  db: KitD1Database
  authorization?: string | null
  cookie?: SessionCookieInput
  hosted?: { userId: string; grantId?: string; clientId?: string }
  organizationId?: string
  delegation?: boolean
  facts?: readonly AuthorizationFact<unknown>[]
}

const emptySnapshot: RequestSnapshot = Object.freeze({
  identity: null,
  platformRole: null,
  organization: null,
  delegation: null,
  rows: () => EMPTY_ROWS,
})

/** One bound batch, directly on the authoritative binding; never a D1 Sessions API or a cache. */
export async function loadRequestSnapshot(input: LoadInput): Promise<RequestSnapshot> {
  try {
    return await load(input)
  } catch {
    // Prepare, execution, overflow and result-shape errors are indistinguishable to callers.
    // Do not preserve a cause: D1 errors can contain SQL, bindings and other private data.
    throw unavailable()
  }
}

type Credentials = {
  candidate: Candidate | null
  delegationToken: string | null
  bearer: string | null
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function hostedCandidate(hosted: NonNullable<LoadInput['hosted']>): Candidate | null {
  const { userId, grantId, clientId } = hosted
  if (!nonblank(userId)) return null
  if (grantId === undefined && clientId === undefined) return { kind: 'mcp', userId }
  if (!(nonblank(grantId) && nonblank(clientId))) return null
  return { kind: 'mcp', userId, grantId, clientId }
}

async function selectCredentials({
  authorization,
  cookie,
  hosted,
  delegation,
}: LoadInput): Promise<Credentials> {
  if (hosted) return { candidate: hostedCandidate(hosted), delegationToken: null, bearer: null }
  const bearer = parseBearer(authorization)
  const token = cookie && (!bearer || delegation) ? await verifySessionCookie(cookie) : null
  const delegationToken = delegation ? token : null
  if (!bearer) {
    return { candidate: token ? { kind: 'session', token } : null, delegationToken, bearer }
  }
  try {
    return { candidate: { kind: 'api_key', prefix: apiKeyPrefix(bearer) }, delegationToken, bearer }
  } catch {
    // Bearer selection is final; the separate delegation fence may still use the cookie.
    return { candidate: null, delegationToken, bearer }
  }
}

type Fact = AuthorizationFact<unknown>
type PlannedFact = { fact: Fact; compiled: CompiledFact }
type PreparedBatch = {
  statements: KitD1Statement[]
  runningFacts: Map<Fact, FactResult>
  productTables: Set<string>
}

function prepare(db: KitD1Database, query: { sql: string; values: readonly unknown[] }) {
  return db.prepare(query.sql).bind(...query.values)
}

function applicableFact(
  scope: Fact['scope']['kind'],
  candidate: Candidate,
  selectedOrg: string | null,
  delegationToken: string | null,
): boolean {
  switch (scope) {
    case 'hosted-grant':
      return (
        candidate.kind === 'mcp' &&
        candidate.grantId !== undefined &&
        candidate.clientId !== undefined
      )
    case 'organization':
    case 'organization-role':
      return selectedOrg !== null
    case 'delegated-user':
    case 'delegated-role':
      return selectedOrg !== null && candidate.kind === 'session' && delegationToken !== null
    case 'user':
      return true
  }
}

function appendFactStatements(
  db: KitD1Database,
  prepared: PreparedBatch,
  facts: readonly PlannedFact[],
  candidate: Candidate,
  selectedOrg: string | null,
  delegationToken: string | null,
  now: number,
): void {
  if (facts.length === 0) return
  const base = candidateQuery(candidate, selectedOrg, now, false)
  let delegatedSource: typeof base | undefined
  for (const { fact, compiled } of facts) {
    const scope = fact.scope.kind
    if (!applicableFact(scope, candidate, selectedOrg, delegationToken)) continue
    let source = base
    if (delegationToken && (scope === 'delegated-user' || scope === 'delegated-role')) {
      delegatedSource ??= withDelegationCandidate(base, delegationToken, now)
      source = delegatedSource
    }
    const index =
      prepared.statements.push(
        prepare(db, {
          sql: ['WITH', source.sql, compiled.sql].join(' '),
          values: [...source.values, ...compiled.values],
        }),
      ) - 1
    if (compiled.productTable) prepared.productTables.add(compiled.table)
    prepared.runningFacts.set(fact, { compiled, index })
  }
}

function appendProductTableCheck(
  db: KitD1Database,
  { statements, productTables }: PreparedBatch,
): number {
  if (productTables.size === 0) return -1
  const sql = [
    "SELECT lower(name) AS name FROM main.sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND lower(name) IN (",
    Array.from(productTables, () => '?').join(', '),
    ')',
  ].join(' ')
  return statements.push(prepare(db, { sql, values: [...productTables] })) - 1
}

async function keyIdentity(
  core: AuthorizationRow,
  subject: string,
  bearer: string,
): Promise<Identity | null> {
  const pin = normalizeApiKeyOrganizationId(requiredString(core, 'key_org'))
  const hash = requiredString(core, 'key_hash')
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw unavailable()
  if (!(pin && (await verifyApiKey(bearer, hash)))) return null
  const expiresAt = core.key_expiry === null ? null : expiry(core, 'key_expiry')
  if (expiresAt !== null && expiresAt <= Date.now()) return null
  const scopes = parseApiKeyScopes(requiredString(core, 'key_scopes'))
  Object.freeze(scopes)
  return Object.freeze({ method: 'api_key', subject, organizationId: pin, scopes })
}

async function resolveIdentity(
  core: AuthorizationRow | null,
  credentials: Credentials,
  now: number,
): Promise<Identity | null> {
  const { candidate, bearer } = credentials
  if (!(core && candidate)) return null
  const subject = requiredString(core, 'subject')
  if (!subject.trim()) throw unavailable()
  switch (candidate.kind) {
    case 'mcp':
      return Object.freeze({ method: 'mcp', subject })
    case 'session':
      if (expiry(core, 'session_expiry') < now) return null
      return sessionIdentity(subject, requiredString(core, 'session_id'), core.email)
    case 'api_key':
      return bearer ? keyIdentity(core, subject, bearer) : null
  }
}

async function projectSnapshot(
  core: AuthorizationRow | null,
  delegationRow: AuthorizationRow | null,
  credentials: Credentials,
  selectedOrg: string | null,
  rows: RequestSnapshot['rows'],
): Promise<RequestSnapshot> {
  const admittedAt = Date.now()
  const delegation = decodeDelegation(delegationRow, admittedAt)
  const identity = await resolveIdentity(core, credentials, admittedAt)
  const platformRole = core ? role(core, 'platform_role') : null
  const org =
    core && selectedOrg !== null ? organization(core, 'membership_role', platformRole) : null
  return Object.freeze({
    identity,
    platformRole: identity ? platformRole : null,
    organization: identity ? org : null,
    delegation,
    rows: identity ? rows : emptySnapshot.rows,
  })
}

async function load(input: LoadInput): Promise<RequestSnapshot> {
  const { db, organizationId, facts = [] } = input
  if (facts.length > MAX_FACTS) throw unavailable()
  const registered = Array.from(new Set(facts), (fact) => ({
    fact,
    compiled: compiledAuthorizationFact(fact),
  }))
  const credentials = await selectCredentials(input)
  const { candidate, delegationToken } = credentials
  if (!(candidate || delegationToken)) return emptySnapshot
  if (!db.batch) throw unavailable()
  const now = Date.now()
  const selectedOrg = organizationId ?? null
  const plan: PreparedBatch = { statements: [], runningFacts: new Map(), productTables: new Set() }
  const { statements } = plan
  const coreIndex = candidate
    ? statements.push(prepare(db, coreQuery(candidate, selectedOrg, now))) - 1
    : -1
  const delegationIndex = delegationToken
    ? statements.push(prepare(db, delegationQuery(delegationToken, now))) - 1
    : -1
  if (candidate)
    appendFactStatements(db, plan, registered, candidate, selectedOrg, delegationToken, now)
  const tableIndex = appendProductTableCheck(db, plan)

  // A D1 binding without Sessions routes to the primary even when read replication is enabled.
  const batch = await db.batch(statements)
  if (!Array.isArray(batch) || batch.length !== statements.length) throw unavailable()
  const rows = productRows(batch, plan.runningFacts, tableIndex)
  const core = coreIndex >= 0 ? singleResult(batch[coreIndex]) : null
  const delegationRow = delegationIndex >= 0 ? singleResult(batch[delegationIndex]) : null
  return projectSnapshot(core, delegationRow, credentials, selectedOrg, rows)
}
