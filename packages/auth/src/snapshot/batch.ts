import type { KitD1Database, KitD1Statement } from '@kit/db'
import {
  type AuthorityQuery,
  AVAILABILITY_SECTION,
  authorityBatchQuery,
  GRANT_SECTION,
  PROJECTION_SECTION,
} from './authority'
import {
  type AuthorizationFact,
  type AuthorizationProjection,
  type CompiledFact,
  compiledAuthorizationFact,
  isAuthorizationProjection,
  MAX_FACTS,
} from './facts'
import { type FactResult, unavailable } from './rows'
import {
  type Candidate,
  candidateQuery,
  coreQuery,
  delegationQuery,
  withDelegationCandidate,
} from './sql'

type Fact = AuthorizationFact<unknown>
type PlannedFact = { fact: Fact; compiled: CompiledFact }
type PreparedBatch = {
  statements: KitD1Statement[]
  runningFacts: Map<Fact, FactResult>
  productTables: Set<string>
}

export type AuthorityPrerequisites = {
  projection: AuthorizationProjection
  availability: Fact
  grant: Fact
}

type BatchScope = {
  candidate: Candidate | null
  selectedOrg: string | null
  delegationToken: string | null
  now: number
  authority: AuthorityPrerequisites | undefined
}

type SnapshotBatch = Pick<PreparedBatch, 'statements' | 'runningFacts'> & {
  coreIndex: number
  delegationIndex: number
  tableIndex: number
}

export function planFacts(facts: readonly Fact[]): PlannedFact[] {
  if (facts.length > MAX_FACTS) throw unavailable()
  return Array.from(new Set(facts), (fact) => ({ fact, compiled: compiledAuthorizationFact(fact) }))
}

function prepare(db: KitD1Database, query: AuthorityQuery) {
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

function appendAuthorityStatement(
  db: KitD1Database,
  prepared: PreparedBatch,
  facts: readonly PlannedFact[],
  source: AuthorityQuery,
  authority: AuthorityPrerequisites,
): void {
  const availability = facts.find(({ fact }) => fact === authority.availability)
  const grant = facts.find(({ fact }) => fact === authority.grant)
  const projection = facts.find(({ fact }) => fact === authority.projection)
  if (
    availability?.fact.scope.kind !== 'organization' ||
    grant?.fact.scope.kind !== 'organization-role' ||
    !projection ||
    !isAuthorizationProjection(projection.fact) ||
    grant === projection
  )
    throw unavailable()
  const query = authorityBatchQuery(
    source,
    availability.compiled,
    grant.compiled,
    projection.compiled,
  )
  const index = prepared.statements.push(prepare(db, query)) - 1
  for (const [{ fact, compiled }, section] of [
    [availability, AVAILABILITY_SECTION],
    [grant, GRANT_SECTION],
    [projection, PROJECTION_SECTION],
  ] as const) {
    if (compiled.productTable) prepared.productTables.add(compiled.table)
    prepared.runningFacts.set(fact, { compiled, index, section })
  }
}

function appendFactStatements(
  db: KitD1Database,
  prepared: PreparedBatch,
  facts: readonly PlannedFact[],
  { candidate, selectedOrg, delegationToken, now, authority }: BatchScope,
): void {
  if (!candidate || facts.length === 0) return
  const base = candidateQuery(candidate, selectedOrg, now, false)
  if (authority && candidate.kind === 'session' && selectedOrg !== null)
    appendAuthorityStatement(db, prepared, facts, base, authority)
  let delegatedSource: typeof base | undefined
  for (const { fact, compiled } of facts) {
    if (prepared.runningFacts.has(fact)) continue
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

export function prepareSnapshotBatch(
  db: KitD1Database,
  facts: readonly PlannedFact[],
  scope: BatchScope,
): SnapshotBatch {
  const { candidate, selectedOrg, delegationToken, now } = scope
  const plan: PreparedBatch = { statements: [], runningFacts: new Map(), productTables: new Set() }
  const { statements, runningFacts } = plan
  const coreIndex = candidate
    ? statements.push(prepare(db, coreQuery(candidate, selectedOrg, now))) - 1
    : -1
  const delegationIndex = delegationToken
    ? statements.push(prepare(db, delegationQuery(delegationToken, now))) - 1
    : -1
  appendFactStatements(db, plan, facts, scope)
  const tableIndex = appendProductTableCheck(db, plan)
  return { coreIndex, delegationIndex, tableIndex, statements, runningFacts }
}
