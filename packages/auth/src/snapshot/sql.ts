type Candidate =
  | { kind: 'session'; token: string }
  | { kind: 'api_key'; prefix: string }
  | { kind: 'mcp'; userId: string; grantId?: string; clientId?: string }

export type { Candidate }

type Query = { sql: string; values: readonly (string | number | null)[] }

const SESSION = `
SELECT u.id AS subject, s.id AS session_id, u.email,
  CASE WHEN typeof(s.expires_at) = 'integer' THEN s.expires_at END AS session_expiry
FROM main."session" AS s
JOIN main."user" AS u ON u.id = s.user_id
WHERE s.token = ? AND u.disabled = 0`

// Confirmed expiry is a denial. Keep malformed expiry in the core result so it
// becomes unavailable, but never select it as a Product fact candidate.
const SESSION_STATE = [
  SESSION,
  "AND (typeof(s.expires_at) <> 'integer' OR s.expires_at >= ?)",
].join(' ')
const SESSION_ELIGIBLE = [
  SESSION,
  "AND typeof(s.expires_at) = 'integer' AND s.expires_at >= ?",
].join(' ')

const KEY = `
SELECT u.id AS subject, k.organization_id AS key_org, k.key_hash, k.scopes AS key_scopes,
  CASE typeof(k.expires_at)
    WHEN 'null' THEN NULL
    WHEN 'integer' THEN k.expires_at
    ELSE 'invalid'
  END AS key_expiry
FROM main."api_keys" AS k
JOIN main."user" AS u ON u.id = k.subject
JOIN main."organization" AS pinned ON pinned.id = k.organization_id
WHERE k.key_prefix = ? AND u.disabled = 0 AND pinned.status = 'active'
  AND k.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM main."member" AS m WHERE m.user_id = u.id AND m.organization_id = pinned.id
  )`

// Core must distinguish a verified key's malformed expiry from confirmed expiry.
// Product fact candidates remain limited to non-expiring or unexpired keys.
const KEY_STATE = [KEY, "AND (typeof(k.expires_at) <> 'integer' OR k.expires_at > ?)"].join(' ')
const KEY_ELIGIBLE = [
  KEY,
  "AND (k.expires_at IS NULL OR (typeof(k.expires_at) = 'integer' AND k.expires_at > ?))",
].join(' ')

const HOSTED = `
SELECT id AS subject, ? AS grant_id, ? AS client_id
FROM main."user"
WHERE id = ? AND disabled = 0`

/** Scope-neutral candidate columns; credential materials are never projected into Product statements. */
export function candidateQuery(
  candidate: Candidate,
  selectedOrg: string | null,
  now: number,
  core: boolean,
): Query {
  let source: string
  let credentials: string
  let bindings: (string | number | null)[]
  switch (candidate.kind) {
    case 'session':
      source = core ? SESSION_STATE : SESSION_ELIGIBLE
      credentials = 'session_id, NULL AS key_org, NULL AS grant_id, NULL AS client_id'
      if (core) credentials += ', email, session_expiry'
      bindings = [candidate.token, now]
      break
    case 'api_key':
      source = core ? KEY_STATE : KEY_ELIGIBLE
      credentials = 'NULL AS session_id, key_org, NULL AS grant_id, NULL AS client_id'
      if (core) credentials += ', key_hash, key_scopes, key_expiry'
      bindings = [candidate.prefix, now]
      break
    case 'mcp':
      source = HOSTED
      credentials = 'NULL AS session_id, NULL AS key_org, grant_id, client_id'
      bindings = [candidate.grantId ?? null, candidate.clientId ?? null, candidate.userId]
      break
  }
  return {
    sql: [
      'kit_candidate AS (SELECT subject, ? AS selected_org,',
      credentials,
      'FROM (',
      source,
      '))',
    ].join(' '),
    values: [selectedOrg, ...bindings],
  }
}

export function coreQuery(candidate: Candidate, selectedOrg: string | null, now: number): Query {
  const query = candidateQuery(candidate, selectedOrg, now, true)
  const columns = ['c.subject', 'platform.role AS platform_role']
  const joins = ['LEFT JOIN main."user_platform_roles" AS platform ON platform.user_id = c.subject']
  if (candidate.kind === 'api_key')
    columns.push('c.key_org', 'c.key_hash', 'c.key_scopes', 'c.key_expiry')
  if (candidate.kind === 'session') columns.push('c.session_id', 'c.email', 'c.session_expiry')
  if (selectedOrg !== null) {
    columns.push('org.status AS organization_status', 'membership.role AS membership_role')
    joins.push(
      'LEFT JOIN main."organization" AS org ON org.id = c.selected_org AND (c.key_org IS NULL OR c.key_org = org.id)',
      'LEFT JOIN main."member" AS membership ON membership.organization_id = org.id AND membership.user_id = c.subject',
    )
  }
  return {
    sql: [
      'WITH',
      query.sql,
      'SELECT',
      columns.join(', '),
      'FROM kit_candidate AS c',
      ...joins,
      'LIMIT 2',
    ].join(' '),
    values: query.values,
  }
}

const DELEGATION = `
SELECT c.subject AS actor, c.session_id, c.session_expiry,
  d.id, d.actor_user_id, d.subject_user_id AS target_id, d.organization_id, d.mode, d.created_at,
  org.status AS organization_status, actor_member.role AS actor_membership_role,
  target_member.role AS target_membership_role, actor_role.role AS actor_platform_role,
  target_role.role AS target_platform_role, target.disabled AS target_disabled,
  permission.read AS permit_read, permission.write AS permit_write,
  actor.name AS actor_name, actor.email AS actor_email,
  target.name AS target_name, target.email AS target_email
FROM cookie_actor AS c
JOIN main."user" AS actor ON actor.id = c.subject
LEFT JOIN main."impersonation_sessions" AS d ON d.session_id = c.session_id
LEFT JOIN main."organization" AS org ON org.id = d.organization_id
LEFT JOIN main."member" AS actor_member ON actor_member.organization_id = org.id AND actor_member.user_id = c.subject
LEFT JOIN main."member" AS target_member ON target_member.organization_id = org.id AND target_member.user_id = d.subject_user_id
LEFT JOIN main."user_platform_roles" AS actor_role ON actor_role.user_id = c.subject
LEFT JOIN main."user_platform_roles" AS target_role ON target_role.user_id = d.subject_user_id
LEFT JOIN main."user" AS target ON target.id = d.subject_user_id
LEFT JOIN main."impersonation_role_permissions" AS permission ON permission.role = actor_role.role`

export function delegationQuery(token: string, now: number): Query {
  return {
    sql: ['WITH cookie_actor AS (', SESSION_STATE, ')', DELEGATION, 'LIMIT 2'].join(' '),
    values: [token, now],
  }
}

const ELIGIBLE_DELEGATION = `), kit_delegated AS (
SELECT session_id, target_id, organization_id
FROM delegation_state
WHERE id IS NOT NULL AND actor_user_id = actor AND actor <> target_id
  AND target_disabled = 0 AND organization_status = 'active'
  AND actor_membership_role <> '' AND target_membership_role <> ''
  AND actor_platform_role IN ('staff', 'super_admin')
  AND (target_platform_role IS NULL OR target_platform_role NOT IN ('staff', 'super_admin'))
  AND ((mode = 'read' AND permit_read = 1) OR (mode = 'write' AND permit_write = 1))
)`

export function withDelegationCandidate(query: Query, token: string, now: number): Query {
  return {
    sql: [
      query.sql,
      ', cookie_actor AS (',
      SESSION_ELIGIBLE,
      '), delegation_state AS (',
      DELEGATION,
      ELIGIBLE_DELEGATION,
    ].join(' '),
    values: [...query.values, token, now],
  }
}
