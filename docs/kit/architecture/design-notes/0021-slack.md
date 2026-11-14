# ADR-0021 design note

Non-normative. Extracted from ADR-0021 on 2026-11-14. Binding only once an accepted ADR amendment adopts it when the code is implemented.

## Racine `@kit/slack`

```ts
import type { KitD1Database } from '@kit/db'

export type SlackErrorCode =
  | 'rate_limited' | 'provider_unavailable' | 'network_error' | 'invalid_response'
  | 'auth_revoked' | 'auth_indeterminate' | 'token_expired' | 'installation_unavailable'
  | 'destination_invalid' | 'identity_unavailable' | 'payload_invalid'
  | 'missing_scope' | 'configuration_invalid' | 'secret_unavailable'
  | 'flow_invalid' | 'workspace_conflict' | 'workspace_unsupported'
  | 'identity_invalid' | 'provider_error'

export type SlackFailure =
  | Readonly<{ status: 'retryable'; code: SlackErrorCode;
      providerCode?: string; retryAfterSeconds?: number }>
  | Readonly<{ status: 'permanent'; code: SlackErrorCode; providerCode?: string }>
export type SlackOutcome<T> = Readonly<{ status: 'ok'; value: T }> | SlackFailure
export type SlackInstallationRef = Readonly<{
  orgId: string
  installationId: string
  generation: number
}>
export type SlackSessionActor = Readonly<{
  orgId: string
  userId: string
  sessionId: string
}>
export type SlackAuthorizationPurpose = 'installation' | 'user_link'
export type SlackCallback =
  | Readonly<{ state: string; code: string }>
  | Readonly<{ state: string; error: string }>
export type SlackInstallationStatusReason =
  | 'auth_indeterminate' | 'revocation_requested'
  | 'token_revoked' | 'account_inactive' | 'token_expired'
export type SlackInstallationView = Readonly<{
  installationId: string
  orgId: string
  teamId: string
  teamName: string
  generation: number
  status: 'active' | 'revoked' | 'disconnecting'
  statusReason: SlackInstallationStatusReason | null
  grantedScopes: readonly string[]
  updatedAt: number
}>
export type SlackUser = Readonly<{
  id: string
  email: string | null
  emailVerified: boolean
}>
export type SlackUserMatch =
  | Readonly<{ kind: 'linked'; slackUserId: string; source: 'oidc' | 'email' }>
  | Readonly<{ kind: 'unmapped'; reason: 'email_unverified' | 'email_absent' |
      'user_not_found' | 'slack_user_inactive' }>
export type SlackChannelView = Readonly<{
  id: string
  name: string
  isPrivate: boolean
  isShared: boolean
}>
export type SlackPlainText = Readonly<{
  type: 'plain_text'; text: string; emoji?: boolean
}>
export type SlackText = SlackPlainText | Readonly<{
  type: 'mrkdwn'; text: string; verbatim?: boolean
}>
export type SlackSection = Readonly<{ type: 'section'; block_id?: string }> & (
  | Readonly<{ text: SlackText; fields?: readonly SlackText[] }>
  | Readonly<{ text?: SlackText; fields: readonly SlackText[] }>
)
export type SlackBlock = SlackSection
  | Readonly<{ type: 'header'; text: SlackPlainText; block_id?: string }>
  | Readonly<{ type: 'context'; elements: readonly SlackText[]; block_id?: string }>
  | Readonly<{ type: 'divider'; block_id?: string }>
export type SlackMessage = Readonly<{
  text: string
  blocks?: readonly SlackBlock[]
}>
export type SlackAddress =
  | Readonly<{ kind: 'channel'; slackChannelId: string }>
  | Readonly<{ kind: 'user'; user: SlackUser }>
export type SlackReceipt = Readonly<{ channelId: string; ts: string }>
export type SlackAuditEvent = Readonly<{
  action: 'slack.connected' | 'slack.disconnect_requested' | 'slack.disconnected' |
    'slack.revoked' | 'slack.auth_disabled' | 'slack.user_linked' | 'slack.user_unlinked'
  orgId: string
  installationId: string
  actorUserId: string | null
  subjectUserId?: string
  meta: Readonly<{ generation?: number; reason?: SlackErrorCode;
    statusReason?: SlackInstallationStatusReason }>
}>
export type SlackKeyring = Readonly<{
  current: Readonly<{ id: string; key: CryptoKey }>
  previous?: Readonly<{ id: string; key: CryptoKey }>
}>
export type SlackOptions = Readonly<{
  database: KitD1Database
  deploymentId: string
  oauth: Readonly<{
    clientId: string
    clientSecret: string
    expectedAppId: string
    installationRedirectUri: string
    userLinkRedirectUri: string
  }>
  keyring: SlackKeyring
  fetch: typeof fetch
  crypto: Crypto
  now: () => number
  audit: (event: SlackAuditEvent) => Promise<void>
}>
export type Slack = Readonly<{
  beginAuthorization(input: Readonly<{
    actor: SlackSessionActor; purpose: SlackAuthorizationPurpose
  }>): Promise<SlackOutcome<Readonly<{
    authorizationUrl: string; expiresAt: number
  }>>>
  completeAuthorization(input: Readonly<{
    actor: SlackSessionActor; purpose: SlackAuthorizationPurpose; callback: SlackCallback
  }>): Promise<SlackOutcome<Readonly<{
    installation: SlackInstallationView
    linkedSlackUserId?: string
  }>>>
  installation(orgId: string): Promise<SlackInstallationView | null>
  disconnect(input: SlackInstallationRef & Readonly<{ actorUserId: string }>):
    Promise<SlackOutcome<Readonly<{ disconnected: true }>>>
  resolveUser(input: SlackInstallationRef & Readonly<{ user: SlackUser }>):
    Promise<SlackOutcome<SlackUserMatch>>
  unlinkUser(input: SlackInstallationRef & Readonly<{ userId: string }>):
    Promise<SlackOutcome<Readonly<{ unlinked: true }>>>
  listChannels(input: SlackInstallationRef & Readonly<{ cursor?: string; limit?: number }>):
    Promise<SlackOutcome<Readonly<{
      items: readonly SlackChannelView[]; nextCursor: string | null
    }>>>
  checkChannel(input: SlackInstallationRef & Readonly<{ slackChannelId: string }>):
    Promise<SlackOutcome<SlackChannelView>>
  postMessage(input: SlackInstallationRef & Readonly<{
    address: SlackAddress; message: SlackMessage
  }>): Promise<SlackOutcome<SlackReceipt>>
}>
export declare function createSlack(options: SlackOptions): Slack
```

## `@kit/slack/notifications`

```ts
import type { Channel } from '@kit/notifications'
import type { Slack, SlackAddress, SlackMessage } from '@kit/slack'

export type SlackNotificationContent = Readonly<{
  message: SlackMessage
  link: Readonly<{ href: string; label: string }>
}>
export type SlackNotificationDelivery = Readonly<{
  orgId: string
  deliveryId: string
  installationId: string
  generation: number
  target: SlackAddress
  message: SlackNotificationContent
}>
export declare function createSlackNotificationChannel(options: Readonly<{
  slack: Pick<Slack, 'postMessage'>
  allowedAppOrigins: readonly string[]
}>): Channel<SlackNotificationDelivery>
export declare function escapeSlackText(text: string): string
```

## Tables de `./schema`

| Table                      | Champs et contraintes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack_installations`      | `id` PK ; `org_id NOT NULL UNIQUE`, `team_id NOT NULL UNIQUE` ; `team_name`, `app_id`, `bot_user_id`, `granted_scopes_json` ; `status active/revoked/disconnecting`, `status_reason NULL` dans les valeurs de `SlackInstallationStatusReason` ; `generation INTEGER NOT NULL` ; `token_ciphertext_json NULL` ; `created_at`, `updated_at` epoch ms. UNIQUE `(id,org_id)` ; `active` implique chiffré présent et reason null ; `disconnecting` implique chiffré conservé et reason `auth_indeterminate` ou `revocation_requested`. |
| `slack_user_links`         | PK `(installation_id,org_id,user_id)` ; `team_id`, `issuer`, `subject`, `slack_user_id`, `created_at`, `updated_at` ; FK composite installation/org. Aucun email ou token OIDC.                                                                                                                                                                                                                                                                                                                                                   |
| `slack_email_matches`      | PK `(installation_id,org_id,user_id)` ; `generation`, `email_fingerprint`, `slack_user_id`, `resolved_at` ; FK composite installation/org. Hint positif seulement, TTL maximal 300 000 ms, jamais preuve durable d’identité ; revalidation Slack avant chaque tentative DM même avant expiration.                                                                                                                                                                                                                                 |
| `slack_oauth_transactions` | `state_hash` PK ; `purpose`, `org_id`, `user_id`, `session_binding_hash`, `created_at`, `expires_at`, `nonce_hash NULL`, `installation_id NULL`, `generation NULL`, `expected_team_id NULL`. Pour `user_link`, ces dernières coordonnées et nonce sont obligatoires. Consommation atomique delete/returning ou CAS équivalent.                                                                                                                                                                                                    |

## Ciphertext

```ts
// Interne persisté, jamais un DTO HTTP.
type SlackTokenCiphertext = Readonly<{
  v: 1
  alg: 'A256GCM'
  kid: string
  iv: string
  ciphertext: string
}>
```

## Bornes Block Kit

| Champ                | Borne                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocks` de message  | **50** au total ; réserver le dernier au lien. Les 100 blocs modals/Home ne s’appliquent pas.                                                                 |
| Top-level `text`     | **4 000 par contrat Kit**, fallback accessible avec sens et lien. Slack recommande 4 000 et tronque au-delà de 40 000 : pas une limite universelle Block Kit. |
| `section.text.text`  | **1…3 000** ; texte ou fields valides requis.                                                                                                                 |
| `section.fields`     | **1…10** si fourni, chacun **1…2 000**.                                                                                                                       |
| `header.text`        | `plain_text` seulement, **1…150**.                                                                                                                            |
| `context.elements`   | **1…10** textes, chacun **1…3 000**.                                                                                                                          |
| `block_id`           | Si présent, non vide et **≤255**, unique dans le message, sans secret/autorité.                                                                               |
| Autre type/propriété | Rejet local `payload_invalid`.                                                                                                                                |

## Routes génériques des destinations

| Route générique                                                      | Entrée                                 | Sortie                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/orgs/{orgId}/notification-destinations`                    | `limit?,cursor?`                       | Page de `{id,channel,externalId,selector,createdAt,updatedAt}`.                                                  |
| `POST /api/orgs/{orgId}/notification-destinations`                   | `{channel,externalId,selector}` strict | 201 `{destination,requestId}`, même DTO. Pour Slack, `externalId` est exactement le tuple JSON défini plus haut. |
| `PUT /api/orgs/{orgId}/notification-destinations/{destinationId}`    | `{selector}` strict                    | 200 `{destination,requestId}`, même DTO ; identité canal/installation immuable.                                  |
| `DELETE /api/orgs/{orgId}/notification-destinations/{destinationId}` | Aucun body                             | 200 `{ok:true,requestId}`.                                                                                       |
