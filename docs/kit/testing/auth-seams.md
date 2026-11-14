# Testing

## Auth test seams (ADR-0002)

Do not lock Better Auth internals forever. Lock **stable wire**:

| Seam                                                     | Where                                          | Stable?                                                                         |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| 1. Crypto / session / key hash                           | `packages/auth` unit                           | **Stable contract** — BA session + `sk_` hash; do not lock BA internals forever |
| 2. Dual path HTTP (cookie + `sk_`) + cookie flags + IDOR | `apps/example-api` integration                 | **Stable**                                                                      |
| 3. FE wire: `credentials: 'include'`, envelope map, 401  | `apps/example-web` `lib/api*` (+ auth helpers) | **Stable**                                                                      |

UI chrome (layout, design-system catalog) is not seam 3.

### Authentication regressions

Authentication changes must preserve the session, Organization isolation and authorization
seams exercised by the permanent regression tests below. Local Example App coverage does not
prove that an external Product has adopted the Kit or that a deployment has migrated.

Permanent `auth-session-regression.test.ts` and `auth-org-regression.test.ts` use the real
Example App HTTP seam and database state changes: missing/invalid/expired/deleted sessions,
refresh/cookies and next-request revocation, alternating identities and Organizations,
nonmember response privacy, suspended members, live membership/Platform Role changes, an
unbound legacy key and audited super-admin read/write break-glass. Existing `app.test.ts`,
`org-rbac.test.ts`, `org-roles-phase-b.test.ts`, `auth-throttle.test.ts`, `flows.test.ts` and
`tasks.test.ts` retain key, Module and custom-role coverage. The nonmember/suspended case was
observed failing with 403 before the change and passing with 404 afterward.

---
