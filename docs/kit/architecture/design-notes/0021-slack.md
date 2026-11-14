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

## Contrat Channel partagé

Le contrat partagé reste exactement :

```ts
type Channel<Input extends { orgId: string }> = Readonly<{
  send(input: Input): Promise<ChannelResult>
}>
type ChannelResult =
  | Readonly<{ status: 'sent' }>
  | Readonly<{ status: 'retryable'; code: string; retryAfterSeconds?: number }>
  | Readonly<{ status: 'permanent'; code: string }>
```

## Préflight et résultats

| Préflight / résultat                                                   | Traitement                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| User sans correspondance, installation inactive, destination supprimée | Le service App écrit `skipped` **avant** Channel. Aucun quatrième résultat ou faux `sent`.                   |
| Slack accepte le POST                                                  | `sent` signifie acceptation transport, pas lecture/réception finale par le User.                             |
| Succès rendu invalide                                                  | Aucun POST ; `permanent/payload_invalid`. Le renderer App et son catalogue restent propriétaires du contenu. |

## Exports

| Export            | Surface                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`               | `createSlack` et types ci-dessus, serveur uniquement ; aucune route Hono ni import App.                                                                                                                                                       |
| `./schema`        | `slackInstallations`, `slackUserLinks`, `slackOAuthTransactions`, `slackEmailMatches`, agrégat `slackDrizzleSchema` ; `SlackInstallationRow`, `SlackUserLinkRow`, `SlackOAuthTransactionRow`, `SlackEmailMatchRow` dérivés de `$inferSelect`. |
| `./notifications` | `createSlackNotificationChannel`, `escapeSlackText`, `SlackNotificationDelivery`, `SlackNotificationContent`.                                                                                                                                 |

## Classification des tentatives

| Observation                                                                                               | Résultat / effet                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 2xx, JSON `ok:true`, `channel`/`ts` valides                                                          | `ok(receipt)→sent` ; HTTP 200 seul ne suffit pas.                                                                                                                            |
| HTTP 429 ou `ok:false,error:'ratelimited'`                                                                | `retryable/rate_limited` ; parse strict digits en entier sûr ≥0 de `Retry-After`, 0 normalisé 1 s, absent/invalide omis. Pas d’invalidation d’identité ou destination.       |
| 5xx/408/réseau/timeout, `service_unavailable`, `internal_error`, `fatal_error`                            | `retryable`, effet distant possiblement ambigu et doublon possible au prochain POST.                                                                                         |
| `channel_not_found`, `is_archived`, `not_in_channel`, `restricted_action`, `no_permission`, User invalide | `permanent/destination_invalid`, Delivery `failed` et diagnostic destination ; pas de révocation globale/join automatique. Invalidation email seulement selon contrat ciblé. |
| `missing_scope`                                                                                           | `permanent/missing_scope`, configuration/réinstallation ; pas une révocation.                                                                                                |
| `invalid_blocks`, `invalid_arguments`, `no_text`, rendu invalide                                          | `permanent/payload_invalid`, zéro réseau si rejet local ; pas de retry du même payload malformé.                                                                             |
| `users_not_found` au matching                                                                             | `ok(unmapped)` puis `skipped` avant Channel, pas une panne provider.                                                                                                         |
| 2xx invalide ou receipt manquante                                                                         | `retryable/invalid_response`, jamais `sent`.                                                                                                                                 |
| Autre 4xx/code inconnu                                                                                    | `permanent/provider_error`, code filtré ou `unknown_error`, diagnostic visible ; pas de boucle infinie ou `skipped` silencieux.                                              |

## Routes d'installation

| Route installation              | Entrée                                 | Sortie / autorité                                                                                                            |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET S/installation`            | —                                      | `{installation:SlackInstallationView                                                                                         | null,requestId}` ; session/org/`manage_notifications`, sans chiffré/kid. |
| `POST S/installation/authorize` | `{}`                                   | `{authorizationUrl,expiresAt,requestId}` ; même autorité + Origin ; pas d’audit de connexion avant commit.                   |
| `GET S/installation/callback`   | `state` + exactement `code` ou `error` | 303 écran org fixe ; session/org/capability **mutation** revérifiée et purpose installation.                                 |
| `DELETE S/installation`         | `{installationId,generation}`          | `{disconnected:true,requestId}` après confirmation, ou erreur explicite et `disconnecting` persisté ; mêmes guards + Origin. |
| `GET S/channels`                | `limit?,cursor?`                       | Page `SlackChannelView` ; même autorité. Publics et privés où bot invité, archivés exclus, pas IM/MPIM.                      |

## Routes personnelles

| Route personnelle          | Entrée                                 | Sortie / autorité                                                             |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `GET S/me/link`            | —                                      | `{source:'oidc'                                                               | 'email' | 'none',slackUserId?,reason?,requestId}` ; session + membership réelle ; pas email, capability admin ou bypass support. |
| `POST S/me/link/authorize` | `{}`                                   | `{authorizationUrl,expiresAt,requestId}` ; même scope + Origin, User session. |
| `GET S/me/link/callback`   | `state` + exactement `code` ou `error` | 303 Settings fixe ; session/membership/purpose + OIDC complet.                |
| `DELETE S/me/link`         | —                                      | `{unlinked:true,requestId}` ; même scope + Origin, aucun User ID client.      |

## Preuves d'implémentation

| Groupe                             | Critères observables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth/OIDC                         | State rejoué/expiré/concurrent/autre session/org/purpose refusé ; membership/capability retirée avant callback refusée. Signature/alg/kid/iss/aud/azp/exp/iat/nbf/nonce/sub/team faux/absents ; JWKS indisponible fermé. Token de test `openid` seul avec team requis. Browser JWT seul ne crée pas une liaison.                                                                                                                                                                                                                    |
| Coffre/lifecycle                   | Courante/précédente, IV neuf, mauvais tag/kid/AAD org/install/team/génération/Deployment ; aucun plaintext DB/log/audit/payload durable. Conflit workspace concurrent sans révoquer la connexion légitime ; toute Grid refusée ; réponse ancienne génération sans impact nouveau token ; `auth.revoke` en panne garde `disconnecting` sans envoi/retry autonome.                                                                                                                                                                    |
| Accès/exposition                   | CP-IDOR/CP-UNAUTH par ressource, `sk_` refusées lectures/callbacks, member/reader/staff/support/break-glass exercés ; GET callback sans bypass lecture pour écrire. Type opt-in filtré serveur, catégorie/`*` ne rend pas tasks collectif ; fan-out une fois même zéro User, Inbox sans Delivery in_app, pas d’exclusion implicite de l’initiateur flows.                                                                                                                                                                           |
| Channel/rendu                      | 429/hints valides/invalides/>86400 sans envoi prématuré ; HTTP200 `ok:false`, receipt manquante, réseau/5xx ambigu, auth CAS/audit unique, destination invalide sans révocation globale. Email absence≠panne, OIDC jamais substitué. N/N+1 pour chaque borne, 50/51 blocs, section/fields/header/context, Unicode/mentions et lien conservé ; aucun import runtime notifications.                                                                                                                                                   |
| Composition/parcours               | Exports et schéma App, migration/catalogue, runtime Worker `jose` compatible ; étapes réussies Workflow non répétées à l’échec de finalisation ; OpenAPI/enveloppes/requestId ; navigateur installation/destinations/lien/unlink/reconnect/disconnect. Revue indépendante auth/isolation/credentials et Durable owner selon `AGENTS.md`, gates applicables du dépôt sans en réduire les exigences.                                                                                                                                  |
| Identité email — finding High      | Amorcer hint frais `e→S1`, changer seulement l’email Slack de S1 et attribuer `e` à S2 sans changer App/fingerprint/génération ; S1 reste actif et son POST accepterait. Avant DM, `users.info(S1)` invalide le hint : aucun POST S1, au plus un lookup courant, seul S2 validé peut recevoir. Couvrir TTL 300000 ms/expiration, email absent, team/bot/deleted, 429/timeout sans POST et sans fallback panne ; retry natif après ancien checkpoint doit recharger User et revalider dans le step d’envoi.                          |
| Auth indéterminée — finding Medium | Injecter `invalid_auth` sur `users.info`, lookup, DM et `auth.revoke` avec token encore valide depuis IP autorisée : CAS `disconnecting/auth_indeterminate`, chiffré inchangé et lisible avec son AAD, aucun nouvel envoi/refresh/retry autonome ; audit/UI sans claim remote-revoked. Après correction IP, l’admin peut appeler `auth.revoke` avec ce même credential puis l’effacer après confirmation ; réponse tardive ancienne génération sans impact nouvelle. Comparer `token_revoked` prouvé et ses reason/audit distincts. |

## Préconditions

| Précondition / résultat | Contrat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session                 | `sessionId` est lu côté serveur Better Auth ; `userId` est celui de cette session pour une liaison. Aucun User ID browser/state ne remplace cette autorité. L’App vérifie session, Organization active, membership et capability avant l’opération HTTP.                                                                                                                                                                                                                                                                                                                        |
| Installation            | Predicates/CAS sur `(orgId,installationId,generation)` ; référence absente/périmée → `installation_unavailable`. Un ID seul ne donne aucune autorité cross-org.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Temps/réseau            | `now()` et données persistées en epoch **ms** ; JWT et `retryAfterSeconds` en **secondes**. Requêtes avec timeout 10 s, hôtes/endpoints fixes et `redirect:'error'`. Aucun claim/paramètre client ne choisit une URL de fetch.                                                                                                                                                                                                                                                                                                                                                  |
| Erreurs                 | Erreurs attendues dans `SlackOutcome` ; `providerCode` filtré `[a-z0-9_]{1,64}` ou `unknown_error`, jamais texte/corps provider/email/token. Erreurs DB/programming inattendues restent exceptions, pas succès/permanence métier devinée.                                                                                                                                                                                                                                                                                                                                       |
| Effets                  | `resolveUser` ne crée ni Notification ni Delivery ; `postMessage` ne choisit pas le User d’App ni une règle. Pour `kind:'user'`, il reçoit le User App courant, résout/revalide lui-même l’identité immédiatement avant `conversations.open`/POST ; un `slackUserId` issu d’un ancien préflight n’est pas accepté comme adresse autoritaire. Identité devenue indisponible après préflight → `permanent/identity_unavailable`, aucun POST ; sinon le bot de l’installation poste vers l’identité courante validée. `ts` reste une string receipt, pas une preuve d’idempotence. |

## Validation OIDC

| Élément                     | Contrôle                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature/clé               | `jose`, **RS256** seulement, JWKS fixe `https://slack.com/openid/connect/keys`. Rejeter JWT malformé, `none`/HS256/autre algorithme, clé invérifiable et extension critique non supportée. `jku`/`x5u`/issuer du token ne pilotent aucun fetch.                                       |
| `iss`                       | String exactement `https://slack.com`, pas suffix matching ou normalisation.                                                                                                                                                                                                          |
| `aud`/`azp`                 | String `clientId`, ou array contenant seulement cet unique public attendu ; aucune audience additionnelle non approuvée. `azp` présent doit être une string égale au client. `jwtVerify` seul ne refuse pas toutes les audiences supplémentaires.                                     |
| `exp`/`iat`/`nbf`           | `exp` et `iat` requis, entiers NumericDate finis en secondes ; `exp>iat`. Tolérance 60 s ; non expiré, `iat≤now+60`, `iat≥now−660`, `iat≥transaction.createdAt/1000−60`. Vérifier `nbf` si présent.                                                                                   |
| `nonce`                     | String requise, hash égal au nonce envoyé, comparaison sûre, avec state lié/consommé une seule fois. Signature valide sans nonce correct = refus.                                                                                                                                     |
| `sub`                       | ASCII non vide, ≤255 caractères ; identité `(issuer,teamId,sub)`. Slack documente `sub` comme ID User : `slackUserId` prend cette valeur validée. Aucun fallback email/claim annexe si `sub` manque ; ne pas imposer l’égalité avec un autre claim dont les exemples Slack divergent. |
| `https://slack.com/team_id` | String non vide, exactement workspace de l’installation **et** transaction ; état/génération rechargés au commit. Le hint `team` n’est pas une preuve.                                                                                                                                |
| `auth_time`/`at_hash`       | Aucun `max_age`/`acr` demandé. `auth_time` présent doit être numérique valide. Si `at_hash` présent, vérifier SHA-256/moitié gauche/base64url de l’access token de cette réponse ; `jwtVerify` ne le fait pas pour nous.                                                              |

## Correspondance email

| Situation      | Traitement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liaison OIDC   | Prioritaire même si emails différents. Un échec DM ne permet jamais un fallback email vers une autre personne ; délier/relier explicitement.                                                                                                                                                                                                                                                                                                                                                   |
| Sans liaison   | User persisté fourni par App après guards ; `emailVerified===true`, email non vide, normalisation `trim().toLowerCase()` actuelle de `@kit/auth`, sans heuristique alias/Gmail/domaine.                                                                                                                                                                                                                                                                                                        |
| Lookup courant | `users.lookupByEmail` avec bot de l’installation ; vérifier `user.id`, `team_id` attendu, `deleted:false`, `is_bot:false`, `is_app_user:false` et `profile.email` normalisé égal à l’email App courant vérifié. Réponse absente/incomplète n’autorise aucun DM. `users_not_found` couvre aussi désactivé → `unmapped` puis `skipped` au préflight. Réseau/429 reste `retryable`.                                                                                                               |
| Cache-hint     | Positif, installation/org/User + génération et SHA-256 du tuple `(orgId,installationId,userId,emailNormalisé)` ; TTL **5 min maximum** depuis `resolved_at`, date future/expirée invalide. Le fingerprint reste une donnée personnelle et ne constate **pas** un changement d’email côté Slack. Même un hint frais ne peut autoriser un POST sans revalidation fournisseur courante. Changement email App/perte de vérification/réinstallation invalide le hint ; aucun cache négatif durable. |
| Déliaison      | Supprimer liaison explicite **et** cache du User courant, puis matching email de nouveau possible. Aucun `auth.revoke` sur le bot ; audit `slack.user_unlinked`. Ce n’est pas un opt-out Slack.                                                                                                                                                                                                                                                                                                |

## Transitions du lifecycle

| Opération                                                                       | Transition et fence                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation initiale acceptée                                                  | Nouvel ID, génération 1, token chiffré, `active` ; unicités org/team appliquées au commit.                                                                                                                                                                                                                                         |
| Réinstallation du même workspace dans la même Organization                      | Même ID, `generation+1`, nouveau token/chiffré/AAD, `active` ; caches email et transactions en attente invalidés. Les liaisons OIDC du même workspace peuvent rester.                                                                                                                                                              |
| `token_revoked` prouvé, compte/workspace définitivement inactif ou token expiré | CAS `(orgId,id,generation,status='active')→revoked`, reason respectivement `token_revoked`, `account_inactive` ou `token_expired` ; seul le premier prouve une révocation distante. Credential définitivement inutilisable écarté, pas de refresh. Une réponse d’ancienne génération ne modifie jamais la nouvelle.                |
| `invalid_auth` ambigu sur n’importe quel appel bot                              | CAS `active→disconnecting`, `statusReason:'auth_indeterminate'`, **sans changer génération/AAD ni supprimer le chiffré**. Credential suspendu localement, conservé pour révocation seulement ; aucun envoi ou retry autonome, révocation admin encore possible après correction IP. Ce n’est pas la preuve d’une révocation Slack. |
| Déconnexion demandée                                                            | CAS vers `disconnecting`, `statusReason:'revocation_requested'`, **sans changer la génération liée à l’AAD** ; aucun nouvel envoi. Chiffré gardé pour révocation seulement ; réinstallation refusée tant que déconnexion non terminée.                                                                                             |
| Révocation confirmée                                                            | Supprimer token/connexion, liaisons/caches/transactions internes ; historique notifications conservé et unicité team libérée. Un retry admin terminé ne cible jamais une nouvelle connexion.                                                                                                                                       |

## Classification auth

| Observation                           | Résultat / effet                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_auth` sur tout appel **bot** | `permanent/auth_indeterminate` pour la tentative ; CAS de cette génération `active→disconnecting`, reason `auth_indeterminate`, token chiffré conservé et désactivé pour révocation admin seulement ; audit `slack.auth_disabled` une fois, prochaines Deliveries `skipped` au préflight. Une restriction IP peut laisser ce token valide ailleurs : ni suppression ni affirmation de révocation distante. Erreur OIDC ≠ état du bot. |
| `token_revoked`, `account_inactive`   | `permanent/auth_revoked`, CAS `active→revoked` avec reason exacte et credential inutilisable écarté ; `token_revoked` peut produire `slack.revoked`, l’inactivité produit `slack.auth_disabled`, pas une fausse preuve de révocation distante. Prochaines Deliveries `skipped`.                                                                                                                                                       |
| `token_expired`                       | `permanent/token_expired`, désactivation/revoked local, reason `token_expired`, audit `slack.auth_disabled` ; pas de refresh ou claim de révocation distante.                                                                                                                                                                                                                                                                         |

## Déconnexion admin

| Après passage local `disconnecting`                           | Traitement                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.revoke → ok:true,revoked:true`                          | Confirmation, suppression token/connexion et audit de déconnexion terminée.                                                                                                                                                                                                                   |
| Token déjà révoqué ou compte/workspace définitivement inactif | Terminaison locale idempotente ; pas de réactivation ou retry de credential inutilisable.                                                                                                                                                                                                     |
| 429/réseau/timeout/5xx                                        | Garder le token **chiffré et désactivé**, usage révocation uniquement ; retour d’échec, UI `disconnecting`, nouvelle tentative admin explicite. Aucun retry autonome.                                                                                                                         |
| `invalid_auth` ou réponse non concluante                      | Ne pas annoncer révocation distante : restriction IP possible. Garder `disconnecting`, reason `auth_indeterminate` si ce code est observé, chiffré désactivé et diagnostic borné pour correction/réessai admin. Même règle de rétention sur tous les appels bot, pas seulement `auth.revoke`. |

## Admission des destinations

| Cible                    | Admission/recheck                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM User                  | User IDs serveur après ACL objet à l’émission ; Organization active, membership et Module effectifs ; Inbox toujours créée puis résolution des Channels externes. Adresse après règles.                                                             |
| Organization destination | Fan-out **indépendant, une fois par émission/cible, même zéro User admissible** ; aucun faux User ou Inbox. Type déclare Slack et `organizationDestinations:true`, destination/sélecteur présents, Organization active et Module disponible/activé. |
| Plafond Deployment       | Règle la plus spécifique type > catégorie > `*`. Locked-off Slack interdit le collectif ; off non locked est un défaut User, pas veto contre l’opt-in collectif. Locked-on ne crée ni destination/opt-in ni accès Module.                           |
| Autres rules             | Organization/User rules des Users ne gouvernent pas cette cible collective. Ne pas choisir un auteur/admin/premier User pour lui appliquer ses préférences. Les DM suivent les trois niveaux de règles du contrat notifications.                    |
| Tentative                | Recharger destination/installation/statut/génération, type/opt-in/Channel, sélecteur, Module et plafond courants. Interdiction observée au dernier recheck → `skipped`. Une transaction D1 n’annule pas un POST déjà accepté.                       |

## Manifest

Manifest ESM `{types,import,default}` comme les Packages voisins. Réutiliser `@kit/db`, Drizzle et Zod 4. `@kit/notifications` est peer workspace optionnel pour le sous-export, et dépendance de développement ; la racine n’exige pas son runtime. `jose` est direct pour JWS/JWKS ; aucun SDK Slack/Bolt, framework OIDC complet ou Package jobs supplémentaire.

## Parcours OAuth

`POST authorize → state persisté → navigation Slack → GET callback → guards revérifiés → state consommé → code échangé → réponse validée → chiffrement/commit → audit → 303 App fixe`.

## Rendu Block Kit

1. L’App rend dans sa locale par défaut **au moment de la tentative**, avec son catalogue ; aucun texte métier/localisé dans le Package.
2. Après schéma strict, borner chaque texte à **son composant**, fields/context à 10, contenu à 49 blocs avec lien. Structures vides/malformées après normalisation : rejet, pas confiance dans la troncature Slack.
3. Lien séparé : href HTTPS absolu sur origin App allowlistée, sans credentials/query de capability/token ; label catalogue. Réserver `<href|label>`, séparateur et ellipse avant troncature. Ajouter fallback **et** dernière section, même sans autres blocks. Lien trop long pour section3000 → erreur, jamais URL coupée/lien supprimé.
4. Comptage conservatif en unités UTF-16 **finales échappées**, pas de paire surrogate coupée ou troncature JSON. Retirer un jeton Slack `<…>` terminal incomplet avant ellipse/lien. Ne pas importer la limite RTM 16 KiB dans HTTP.

## Pagination

Destinations persistées : `ListQuery`, limite 1…100/default50, cursor≤512, keyset exact `{createdAt,id}` décroissant après scope org. Canaux : cursor opaque validé contenant installation/génération et cursor Slack ; référence périmée refusée, jamais choix de token. Relayer une page `conversations.list(public_channel,private_channel,exclude_archived:true)`, sans charger toute la liste pour fabriquer un keyset. Une page vide peut avoir un next cursor provider. Paramètre répété →400.

## Sources fournisseur

| Contrat                 | Source primaire                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth/OIDC/scopes       | [Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack/), [openid.connect.token](https://docs.slack.dev/reference/methods/openid.connect.token/), [oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access/), [discovery](https://slack.com/.well-known/openid-configuration).                                                                                           |
| Validation ID token/TLS | [OIDC Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation), [§3.1.3.8](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowTokenValidation).                                                                                                                                                                                                                         |
| PKCE/révocation         | [PKCE](https://docs.slack.dev/authentication/using-pkce/), [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke/).                                                                                                                                                                                                                                                                                  |
| Identité/canaux/envoi   | [users.lookupByEmail](https://docs.slack.dev/reference/methods/users.lookupByEmail/), [users.info et email](https://docs.slack.dev/reference/methods/users.info/), [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).           |
| Auth indéterminée       | [Slack IP allowlist et `invalid_auth`](https://docs.slack.dev/concepts/security/#restrict-ip-addresses) : cette réponse peut signaler une IP refusée, sans invalider le token.                                                                                                                                                                                                                                    |
| Bornes Block Kit        | [Blocks](https://docs.slack.dev/reference/block-kit/blocks/), [Section](https://docs.slack.dev/reference/block-kit/blocks/section-block/), [Header](https://docs.slack.dev/reference/block-kit/blocks/header-block/), [Context](https://docs.slack.dev/reference/block-kit/blocks/context-block/), [Text object](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/).                    |
| Sécurité/runtime        | [Cloudflare WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [registre jose](https://registry.npmjs.org/jose/latest), [jose](https://github.com/panva/jose), [jwtVerify](https://github.com/panva/jose/blob/v6.2.13/docs/jwt/verify/functions/jwtVerify.md), [RemoteJWKSetOptions](https://github.com/panva/jose/blob/v6.2.13/docs/jwks/remote/interfaces/RemoteJWKSetOptions.md). |

## Événements d'audit

| Actions                                                                               | Acteur / meta allowlist                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack.connected`, `slack.disconnect_requested`, `slack.disconnected`                 | User admin réel ; org/installation en colonnes dédiées ; `{generation,reason?}`.                                                                                                      |
| `slack.revoked`                                                                       | Acteur null ; CAS par génération, uniquement révocation fournisseur prouvée, une émission ; `{generation,reason,statusReason}`, jamais nouvelle connexion visée par ancienne réponse. |
| `slack.auth_disabled`                                                                 | Acteur null ; suspension locale sur `invalid_auth`, inactivité ou expiration, CAS/audit une fois ; `{generation,reason,statusReason}`. Jamais synonyme de révocation distante.        |
| `slack.destination_created`, `slack.destination_updated`, `slack.destination_deleted` | User admin réel ; destination en target ; `{installationId,slackChannelId,selectorKind,selectorValue?}`.                                                                              |
| `slack.user_linked`, `slack.user_unlinked`                                            | User session/subject ; installation en target ; `{installationId,subjectUserId,method}`. Un cache email n’est pas un consentement explicite fictif.                                   |

## Coffre AES-GCM

| Élément         | Contrat                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clés            | AES-GCM 256 bits CSPRNG dédiée, import non extractible encrypt/decrypt ; IDs courant/précédent distincts. Aucun dérivé de `client_secret` ou `BETTER_AUTH_SECRET`. L’App mappe les secrets Worker vers le trousseau ; aucun binding global lu par le Package.           |
| IV/tag          | IV **12 octets** CSPRNG neuf à chaque chiffrement/rechiffrement/réinstallation ; tag **128 bits**. Base64url d’IV et de `ciphertext                                                                                                                                     |     | tag` WebCrypto. Aucun IV dérivé de timestamp/orgId. |
| AAD             | UTF-8 `JSON.stringify(['@kit/slack',1,'bot-token',deploymentId,orgId,installationId,teamId,generation,kid])`, ordre fixé. Reconstituer depuis les coordonnées attendues, pas seulement celles du blob. Copier vers autre org/install/team/génération/Deployment échoue. |
| Déchiffrement   | `kid` sélectionne une clé exacte, pas un essai de toutes. Version/alg/kid/IV/tag/AAD invalides → `permanent/secret_unavailable`, aucun envoi, diagnostic redacted ; pas une révocation supposée chez Slack.                                                             |
| Rotation coffre | Écrire courante, lire précédente. La précédente n’est retirée qu’après rechiffrement CAS/reconnexion des lignes et prise en compte des backups requis ; finir ce passage avant rotation suivante. Pas de Cron/moteur de rotation/reprise supplémentaire.                |
