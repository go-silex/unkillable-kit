type Candidate =
  | { kind: 'session'; token: string }
  | { kind: 'api_key'; prefix: string }
  | { kind: 'mcp'; userId: string }

export type { Candidate }

type Query = { sql: string; values: (string | null)[] }

// No SQLite affinity or schema collation participates in an identifier comparison.
// The first conjunct also permits the planner to use a binary index when available.
function same(left: string, right: string) {
  return `(${left} COLLATE BINARY = ${right} AND typeof(${left}) = 'text' AND typeof(${right}) = 'text' AND +${left} COLLATE BINARY = +${right})`
}

const CREDENTIAL = '(SELECT credential_id FROM parameters)'
const SELECTION = '(SELECT selected_org FROM parameters)'
const SESSION = `
SELECT u.id AS subject, u.disabled, u.email, u.name, s.id AS session_id, s.expires_at AS session_expiry
FROM main."session" AS s
JOIN main."user" AS u ON ${same('u.id', 's.user_id')}
WHERE ${same('s.token', CREDENTIAL)}`

const KEY = `
SELECT u.id AS subject, u.disabled, k.id AS key_id, k.organization_id AS key_org,
  k.key_hash, k.scopes AS key_scopes, k.expires_at AS key_expiry
FROM main."api_keys" AS k
JOIN main."user" AS u ON ${same('u.id', 'k.subject')}
JOIN main."organization" AS pinned ON ${same('pinned.id', 'k.organization_id')}
JOIN main."member" AS pin_member ON ${same('pin_member.organization_id', 'pinned.id')}
  AND ${same('pin_member.user_id', 'u.id')}
WHERE ${same('k.key_prefix', CREDENTIAL)} AND pinned.status COLLATE BINARY = 'active'
  AND k.revoked_at IS NULL`

const HOSTED = `
SELECT u.id AS subject, u.disabled
FROM main."user" AS u WHERE ${same('u.id', CREDENTIAL)}`

function credential(candidate: Candidate) {
  switch (candidate.kind) {
    case 'session':
      return { sql: SESSION, value: candidate.token }
    case 'api_key':
      return { sql: KEY, value: candidate.prefix }
    case 'mcp':
      return { sql: HOSTED, value: candidate.userId }
  }
}

export function coreQueries(
  candidate: Candidate,
  selectedOrg: string | undefined,
  delegated: boolean,
  modules: boolean,
) {
  const { sql, value } = credential(candidate)
  const queries: { core: Query; modules?: Query } = {
    core: {
      sql: `WITH parameters AS (SELECT ? AS credential_id), credential AS (${sql})
        SELECT c.*, platform.role AS platform_role
        FROM credential AS c LEFT JOIN main."user_platform_roles" AS platform
          ON ${same('platform.user_id', 'c.subject')} LIMIT 2`,
      values: [value],
    },
  }
  if (selectedOrg === undefined) return queries

  const useDelegation = delegated && candidate.kind === 'session'
  const attachment = useDelegation
    ? `LEFT JOIN main."impersonation_sessions" AS d ON ${same('d.session_id', 'c.session_id')}`
    : ''
  const matchesBinding =
    candidate.kind === 'api_key'
      ? `AND ${same('org.id', 'c.key_org')}`
      : useDelegation
        ? `AND (d.session_id IS NULL OR ${same('org.id', 'd.organization_id')})`
        : ''
  const effectiveSubject = useDelegation
    ? 'CASE WHEN d.session_id IS NULL THEN c.subject ELSE d.subject_user_id END'
    : 'c.subject'
  const scope = `
    FROM credential AS c ${attachment}
    LEFT JOIN main."organization" AS org ON ${same('org.id', SELECTION)} ${matchesBinding}
    LEFT JOIN main."member" AS membership ON ${same('membership.organization_id', 'org.id')}
      AND ${same('membership.user_id', `(${effectiveSubject})`)}
    ${
      modules
        ? `LEFT JOIN main."organization_roles" AS org_role
      ON ${same('org_role.organization_id', 'org.id')} AND ${same('org_role.key', 'membership.role')}`
        : ''
    }`
  queries.core = {
    sql: `WITH parameters AS (SELECT ? AS credential_id, ? AS selected_org), credential AS (${sql})
      SELECT c.*, platform.role AS platform_role, org.id AS org_id, org.kind AS org_kind,
        org.status AS org_status, membership.role AS membership_role
      ${scope}
      LEFT JOIN main."user_platform_roles" AS platform ON ${same('platform.user_id', 'c.subject')}
      LIMIT 2`,
    values: [value, selectedOrg],
  }
  if (modules) {
    queries.modules = {
      sql: `WITH parameters AS (SELECT ? AS credential_id, ? AS selected_org), credential AS (${sql})
        SELECT om.module_id, om.enabled, pm.available, grants.access
        ${scope}
        JOIN main."organization_modules" AS om ON ${same('om.organization_id', 'org.id')}
        LEFT JOIN main."platform_modules" AS pm ON ${same('pm.module_id', 'om.module_id')}
        LEFT JOIN main."organization_role_module_grants" AS grants
          ON ${same('grants.role_id', 'org_role.id')} AND ${same('grants.module_id', 'om.module_id')}`,
      values: [value, selectedOrg],
    }
  }
  return queries
}

export function delegationQuery(token: string): Query {
  return {
    sql: `WITH parameters AS (SELECT ? AS credential_id), cookie_actor AS (${SESSION})
      SELECT c.subject AS actor, c.session_id, c.session_expiry, c.disabled AS actor_disabled,
        d.id, d.actor_user_id, d.subject_user_id AS target_id, d.organization_id, d.mode, d.created_at,
        org.id AS org_id, org.kind AS org_kind, org.status AS org_status,
        actor_member.role AS actor_membership_role, target_member.role AS target_membership_role,
        actor_role.role AS actor_platform_role, target_role.role AS target_platform_role,
        target.disabled AS target_disabled, permission.read AS permit_read, permission.write AS permit_write,
        c.name AS actor_name, c.email AS actor_email, target.name AS target_name, target.email AS target_email
      FROM cookie_actor AS c
      LEFT JOIN main."impersonation_sessions" AS d ON ${same('d.session_id', 'c.session_id')}
      LEFT JOIN main."organization" AS org ON ${same('org.id', 'd.organization_id')}
      LEFT JOIN main."member" AS actor_member ON ${same('actor_member.organization_id', 'org.id')}
        AND ${same('actor_member.user_id', 'c.subject')}
      LEFT JOIN main."member" AS target_member ON ${same('target_member.organization_id', 'org.id')}
        AND ${same('target_member.user_id', 'd.subject_user_id')}
      LEFT JOIN main."user_platform_roles" AS actor_role ON ${same('actor_role.user_id', 'c.subject')}
      LEFT JOIN main."user_platform_roles" AS target_role ON ${same('target_role.user_id', 'd.subject_user_id')}
      LEFT JOIN main."user" AS target ON ${same('target.id', 'd.subject_user_id')}
      LEFT JOIN main."impersonation_role_permissions" AS permission ON ${same('permission.role', 'actor_role.role')}
      LIMIT 2`,
    values: [token],
  }
}
