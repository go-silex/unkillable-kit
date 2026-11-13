# Auth abuse response (kit)

**Issue:** B-auth-harden
**Audience:** platform super_admin / on-call kit operators

## What protects auth endpoints

| Control     | Store                       | Notes                                                          |
| ----------- | --------------------------- | -------------------------------------------------------------- |
| Rate limit  | **D1** `rate_limit_buckets` | Floor-aligned fixed window; **shared across Workers isolates** |
| Audit trail | **D1** `audit_events`       | Append-only; list API super_admin only                         |

In-memory Maps are **not** used. Multi-isolate safety = shared D1 counters.

### Better Auth: deny by default

The kit D1 limiter is the **only** Better Auth limiter. `createBetterAuth` pins Better Auth's own limiter off (`rateLimit: { enabled: false }`): it is memory per isolate, keyed `ip|path`, and on only when `NODE_ENV` is `production`. Pinning it off also turns off the rate-limit rules plugins declare (magic link's 5 / 60 s, for instance).

A product mounts Better Auth per the [Better Auth mount contract](./product-consumer-contract.md#better-auth-mount): the organization-route deny, then `throttleBetterAuthRequest` (`@kit/auth/repos/ba-throttle`), then `auth.handler`. Deny by default holds for the **address bucket** only. The e-mail and session-ending sets are kit lists:

- **Exempt:** `GET /api/auth/get-session` and `GET /api/auth/ok`, exact match. Any other method or path variant spends budget.
- **Address bucket:** every other request, so an endpoint Better Auth or a plugin adds spends it the day it ships.
- **E-mail bucket (kit list):** `POST` to `sign-in/email`, `sign-in/magic-link`, `request-password-reset` and `send-verification-email`. These share one budget per address named in the body. The e-mail is read from the JSON body and lower-cased, as Better Auth does. An unreadable e-mail is a **400** before Better Auth.
- **Session bucket:** every request that carries a session, except the session-ending `POST`s (kit list: `sign-out`, `revoke-session`, `revoke-sessions`, `revoke-other-sessions`), keyed by the session id. A second session of the same account has its own budget, so it cannot block the owner's password change.

A product that enables another Better Auth plugin gets the address and session buckets on its endpoints. An endpoint that names an account by e-mail (email OTP, for instance) gets the e-mail bucket only once a kit PR adds it to the list.

Trusted internal operations instead use `throttleBetterAuthActorRequest` before handling their synthetic request. The caller authenticates a stable actor server-side and separately authorizes the operation; model output and caller-controlled headers are not actor authority. This is not a raw HTTP auth mount. It spends an isolated actor source bucket, not an IP or session bucket, while using the same exemptions and e-mail policy. A shared recipient budget can deny both native and internal requests, regardless of actor. Missing or blank actor identity is rejected.

Drift detector: `apps/example-api/src/auth-throttle.test.ts` enumerates `auth.api` for the plugin set of `example-api`. It fails when an endpoint whose body may name an e-mail (a key matching `email`, or a body whose keys cannot be read) is neither budgeted nor listed with a reason, and when an endpoint that names a sign-out or a revocation is neither session-ending nor listed. It checks the lists, not the charge. The charges are proved by `packages/auth/src/repos/ba-throttle.test.ts` and by the rotating-address cases of `auth-throttle.test.ts`. A product with other plugins runs the same enumeration on its own instance.

### Fixed window + ~2× burst

Counters use `windowStartMs = floor(now / windowMs) * windowMs`.  
Across a window boundary, a client may briefly send up to **~2×** the configured limit (end of window + start of next). This is expected for MVP; escape hatches: Cloudflare Rate Limiting binding or shorter windows.

### Defaults (code constants)

| Surface                                            | Typical key                                                                                                | Limit / window                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Better Auth, any request but the two session reads | `ba-auth:{ip}` (IPv4 address or normalized IPv6 /64) · `ba-auth:no-platform-ip` without a platform address | 20 / 15 min                            |
| Better Auth, trusted internal actor                | `ba-auth-actor:{actorId}`                                                                                  | 20 / 15 min, per server-verified actor |
| Better Auth, e-mail sign-in / mail sends           | `ba-auth-email:{sha256(lower-cased e-mail)}`                                                               | 20 / 15 min, shared by the 4 paths     |
| Better Auth, session holder                        | `ba-auth-session:{sessionId}`, one budget per session, not per account                                     | 20 / 15 min                            |
| Admin create user                                  | `admin-user-create:{actor}`                                                                                | 20 / 1 h                               |
| Invite create                                      | `invite-create:{orgId}`                                                                                    | 20 / 1 h                               |
| Invite accept                                      | `invite-accept:ip:{ip}` · `invite-accept:sub:{subject}` without a platform address                         | 30 / 1 h                               |
| API key mint                                       | `mint:{subject}`                                                                                           | (see me.ts)                            |
| Demo email / feedback                              | subject keys                                                                                               | (see routes)                           |

Better Auth limits are kit constants (`BA_THROTTLE_LIMIT`, `BA_THROTTLE_WINDOW_MS` in `@kit/auth/repos/ba-throttle`): tighten them through a kit PR or a Cloudflare edge rule, per the [mount contract](./product-consumer-contract.md#better-auth-mount). The others are constants in `apps/example-api` (no env overrides in this epic).

### Client address (`clientIp`)

`clientIp` (`@kit/auth/repos/rate-limit`) validates `cf-connecting-ip` and returns a bucket key, else `null`. IPv4 keeps its dotted-decimal address; IPv4-mapped IPv6 uses the same IPv4 key. Other IPv6 literals are normalized to their /64, so addresses and equivalent spellings in one /64 share a bucket. This applies to both Better Auth and invitation acceptance. The header is an identity **only behind the Cloudflare edge**, which overwrites it. Elsewhere it is caller-chosen or absent. Local `wrangler dev` keeps a header the caller sends and sets the socket peer's address otherwise. Other runtimes may send none, or anything. `X-Forwarded-For` is never read.

For operator lookup, an IPv6 key uses four lowercase hexadecimal hextets without leading zeroes, including explicit zero hextets, followed by `::/64`: for example, `2001:db8:0:0::/64`.

The /64 policy requires the actual IPv6 address to reach the Worker. Cloudflare Pseudo IPv4 in **Overwrite Headers** mode replaces `CF-Connecting-IP` with a pseudo IPv4 address, masking the IPv6 prefix; verify the Product's Cloudflare configuration and disable Pseudo IPv4 or use **Add Header** rather than **Overwrite Headers**.

On rollout, existing raw IPv6 keys are not migrated: the new /64 key starts a fresh window, and old rows remain subject to the retention behavior below.

### Residual risks (accepted)

| Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why accepted                                                                                                                                                              | Removal condition                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Cross-site address lockout.** Any page can make a visitor's browser send 20 GETs to `/api/auth/*`, one `<img>` tag each, on any path, including one that does not exist. `originGuard` passes safe methods and Better Auth checks no origin on GET, so each one spends `ba-auth:{ip}`. That visitor and everyone sharing the IPv4 NAT or IPv6 /64 bucket are then locked out of every non-exempt Better Auth request for the window: sign-in, sign-out, session revocation, magic-link verify and password reset included. A top-level navigation also carries the `SameSite=Lax` cookie and spends the visitor's session bucket | The address bucket is the only per-source cap on credential-less endpoints; no account state changes and the lockout ends with the window                                 | A Fetch-Metadata gate that answers cross-site non-navigation requests before any charge      |
| **Address sharing and rotation.** Everyone behind one IPv4 NAT or within one IPv6 /64 shares a bucket and can lock out others. A client able to rotate across IPv4 addresses or IPv6 /64 prefixes can spend a separate budget per address or prefix                                                                                                                                                                                                                                                                                                                                                                                | The e-mail bucket bounds account-targeted guessing and mail sends; session-bound password checks are bounded per session. Token endpoints need a token Better Auth issued | A trusted stronger client identity or additional edge controls                               |
| **Known-e-mail lockout.** 20 requests per 15 min naming a known e-mail, even from one address, lock that account out of sign-in, magic link, password reset and verification mail for the window. Rotating addresses lets an attacker lock a whole staff list. The 429 and its log carry `{code, status}` only, not the bucket                                                                                                                                                                                                                                                                                                     | The budget is what stops password guessing and mail bombing across rotating addresses (Roxabi/roxabi-boilerplate-cf#394)                                                  | A proof-of-work or CAPTCHA step that lets the owner through; the bucket class in the 429 log |
| **Alias mail bombing.** `+tag` and dot variants are distinct keys, each with its own e-mail budget, yet reach one inbox. `sign-in/magic-link` mails any syntactically valid address and checks the account only at verify, so mail to one inbox is bounded by the number of aliases times the number of source addresses                                                                                                                                                                                                                                                                                                           | Alias rules are provider-specific; mail goes only to the inbox named                                                                                                      | A mailbox-normalised e-mail key                                                              |
| **Off-edge address source.** Only the Cloudflare edge overwrites `cf-connecting-ip`. A caller that reaches the Worker another way can choose valid IPv4 addresses or IPv6 prefixes per request, so for an attacker the address bucket fails open. Callers that send no valid header share `ba-auth:no-platform-ip`: 20 requests per 15 min block all of them. A cross-zone Cloudflare subrequest carries a Cloudflare address, shared by every caller behind it                                                                                                                                                                    | Kit deploys run behind the Cloudflare edge; the e-mail and session buckets still bind                                                                                     | A trusted address source on the other runtime                                                |
| **E-mail pseudonym.** The e-mail key is an unsalted SHA-256: guessable from a list of addresses, not an anonymisation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fixed-size key, no address in clear                                                                                                                                       | A keyed hash (HMAC) if the table leaves the trust boundary                                   |
| **Retention.** Expired `rate_limit_buckets` rows are deleted only when the same key is charged again. A `ba-auth-email:` row is written for any address submitted, account or not, so a third party's address typed once stays in D1 indefinitely, next to the clear-text IPv4 addresses or IPv6 prefixes of `ba-auth:` and `invite-accept:ip:` keys. A flood across many keys grows the table                                                                                                                                                                                                                                     | Out of scope of Roxabi/roxabi-boilerplate-cf#394                                                                                                                          | A periodic purge                                                                             |

### Fail-closed

If D1 is unavailable during a rate-limit check, the request fails with **500 `INTERNAL_ERROR`** — the limit is never skipped.

## Audit events

| Action              | When                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| `user.created`      | Admin create-user; invite-path shell provision                                   |
| `platform_role.set` | Platform role assigned on create                                                 |
| `membership.add`    | Membership insert (admin create / invite accept)                                 |
| `first_login`       | First BA session create (password, magic, or set-password) — idempotent per user |
| `invite.accept`     | Invitation accepted                                                              |

Payloads use **allowlisted meta** only (no passwords, tokens, Authorization, cookie bodies).

### List recent events

```http
GET /api/admin/audit-events?limit=50&cursor=
```

- **Auth:** session cookie with platform role `super_admin` (`sk_` Bearer is 403)
- **401** unauthenticated · **403** API key, or session without `super_admin`
- Cursor format: `{createdAt}:{id}`

### Residual risk: best-effort write

Audit insert runs **after** the domain mutation. If audit write fails, the domain change stays committed and a structured log is emitted:

```json
{ "level": "error", "msg": "audit_append_failed", "action": "...", "requestId": "..." }
```

Alert on elevated `audit_append_failed` rate. Full outbox / SIEM is out of scope.

## Response playbook

Run the SQL of this playbook from the product API app as `bunx wrangler d1 execute <db> --remote --env <env> --command "<sql>"`, as the [rollback runbook](./deploy-cloudflare.md) does. Without `--remote`, wrangler queries the local `.wrangler` database and still reports success.

1. **Identify spray** — 429 spikes on auth; note `cf-connecting-ip` / client IP. The 429 log carries `{code, status}` only, so read the live Better Auth buckets in D1: `SELECT bucket_key, count, window_start_ms FROM rate_limit_buckets WHERE bucket_key LIKE 'ba-auth%' AND window_start_ms > unixepoch() * 1000 - 900000 ORDER BY count DESC LIMIT 50`. The filter keeps the current window: `900000` is `BA_THROTTLE_WINDOW_MS` (15 minutes), so change it with that constant. Rows of an older window are expired, and they stay until their key is charged again. A full `ba-auth:no-platform-ip` means requests arrive without a platform address (off Cloudflare).
2. **Confirm limits** — the same IPv4 address or IPv6 /64 should share a D1 counter across isolates (if not, check D1 binding / migration applied). IPv4 addresses behind the same NAT also share a counter. One account locked out of sign-in from many addresses points at its `ba-auth-email:` row; one session locked out points at its `ba-auth-session:` row. `ba-auth-email:` keys are hashes, so compute the lower-case hex SHA-256 of the lower-cased e-mail to find one.
3. **Inspect audit** — `GET /api/admin/audit-events` with a **super_admin session cookie** (not an API key) for create-user, role, invite, first_login anomalies.
4. **Contain** — disable public signup (`ALLOW_PUBLIC_SIGNUP` off). A password reset alone does not contain a compromised account. It ends no session (`createBetterAuth` leaves `revokeSessionsOnPasswordReset` unset), and a live session mints `sk_` keys (`POST /api/keys`) and MCP tickets. Disable the account's password first. Then end its sessions and revoke its API keys and MCP grants. Send a set-password link (`POST /api/admin/users/<user-id>/resend-welcome`) last. The kit does not ship tested commands for these steps yet: Roxabi/roxabi-boilerplate-cf#408 tracks the runbook.

   While the account's e-mail bucket is full, its self-service reset (`request-password-reset`) spends that bucket and gets 429 until the window ends.
5. **Tighten** — lower code constants and redeploy; optional CF WAF / Rate Limiting for edge volume.
6. **Product forks** — mount Better Auth per the [Better Auth mount contract](./product-consumer-contract.md#better-auth-mount). Never add a product-side throttle path list: the e-mail and session-ending lists change through a kit PR. Never send caller input directly to `auth.api.*` or `auth.fetch`: those calls do not charge buckets themselves. Trusted internal operations must use the actor admission contract and enforce their own authentication and authorization.

## Related

- ADR-0002 Better Auth only
- Frame/spec: product tracker
- Environments and example staging: [`docs/kit/environments.md`](./environments.md)
