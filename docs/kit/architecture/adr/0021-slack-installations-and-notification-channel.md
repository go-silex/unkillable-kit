---
title: 'ADR-0021 — Installations Slack et Channel de notifications'
status: accepted
normative: true
date: 2026-10-22
amended: 2026-11-14
axial: false
related:
  - AGENTS.md
  - GLOSSARY.md
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0003-multi-tenant-rbac-modules.md
  - docs/kit/architecture/adr/0008-kit-schema-identity-product-compose.md
  - docs/kit/architecture/adr/0012-kernel-persistence-request-context.md
  - docs/kit/architecture/adr/0018-durable-execution-ownership.md
  - docs/kit/standards/stack.md
  - docs/kit/api-contract.md
  - 'Roxabi/roxabi-boilerplate-cf#470'
  - 'Roxabi/roxabi-boilerplate-cf#481'
  - 'Roxabi/roxabi-boilerplate-cf#482'
  - 'Roxabi/roxabi-boilerplate-cf#484'
  - 'Roxabi/roxabi-boilerplate-cf#461'
  - 'Roxabi/roxabi-boilerplate-cf#462'
---

# ADR-0021 — Installations Slack et Channel de notifications

Le Kit fournit `@kit/slack` pour connecter une Organization à un workspace Slack, lier les Users et envoyer des notifications sans recopier OAuth, OIDC ou le stockage de credentials dans chaque App. Le Package cache ces mécanismes derrière une interface serveur ; l’App conserve ses routes, ses accès, ses Notification types et ses Durable owners.

Contrat accepté le 2026-10-22, dont `jose` direct, la conservation du token chiffré désactivé en cas de déconnexion indéterminée, les Organization destinations indépendantes du nombre de Users et le Workflow complet par Delivery. Le dépôt ne contient pas de `packages/slack` : les interfaces et parcours ci-dessous sont une cible, pas une implémentation ni une preuve fournisseur ou de déploiement.

## Contexte et décision

| Choix          | Décision                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connexion      | Une app Slack par Deployment, distribution publique non listée, OAuth v2 confidentiel serveur ; une Slack installation par Organization et un workspace par Organization. |
| Destinations   | Plusieurs Organization destinations ; DM aux Users par email vérifié ou liaison OIDC explicite prioritaire.                                                               |
| Credentials    | Bot token chiffré AES-256-GCM, clé dédiée avec identifiant et trousseau courant/précédent ; pas de rotation des tokens Slack en V0.                                       |
| Surface        | `@kit/slack` serveur, `@kit/slack/schema`, Channel `@kit/slack/notifications` important notifications **en types seulement**.                                             |
| Hors périmètre | Webhooks entrants, Events API, interactivité Slack, Enterprise Grid, GovSlack, login App par Slack et refresh autonome.                                                   |

Scopes bot : `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, `im:write`, `users:read`, `users:read.email`. Le flux OIDC séparé demande `openid`, sans scope bot ou `incoming-webhook`. Le bot doit être invité aux canaux privés ; changer de canal ne nécessite pas de réinstallation. Certains workspaces refusent les apps non Marketplace : la distribution non listée ne contourne pas cette politique. `auth.revoke` désactive le bot et retire ses memberships ; ce n’est pas une désinstallation complète de l’app Slack.

### Propriétaires et invariants

| Propriétaire               | Responsabilité                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kit/slack`               | State/nonce, OAuth/OIDC, coffre, liaisons/cache email, appels Slack typés, transitions conditionnelles d’installation et événements d’audit structurés.                                                           |
| `@kit/slack/schema`        | Tables Slack et FKs internes org-scopées, composées par l’App selon ADR-0012. Aucune table dans `@kit/db`.                                                                                                        |
| `@kit/slack/notifications` | Bornes/rendu Slack et adaptation vers le `Channel`/`ChannelResult` du cœur notifications.                                                                                                                         |
| App                        | Routes/guards/OpenAPI ; Notification producer ; service de création des Notifications ; catalogues/locale ; configuration générique des Organization destinations ; audit persisté ; bindings/secrets/migrations. |
| Workflow de Delivery       | Exécution complète à ID stable : préflight, rendu/résolution, tentative Channel, reprises natives, statut terminal. Aucun retry, sleep, publication de remplacement ou Cron de reprise dans le Package Slack.     |

1. **Organization obligatoire.** Chaque opération porte `orgId` et l’installation ; aucun registre global ou credential ambiant.
2. **Accès → Inbox toujours → Channels externes.** Une DM ne remplace jamais la Notification de l’Inbox. Aucune Delivery `in_app` n’est produite ou suivie.
3. **Credentials confinés.** Aucun token persisté, journalisé, exposé par route ou passé dans le payload durable en clair. Le plaintext existe nécessairement pendant OAuth et l’appel HTTPS sortant, dans la mémoire de la tentative seulement.
4. **Identité prouvée.** Liaison explicite : session App préexistante, state consommable une fois, signature et claims OIDC valides, workspace égal à l’installation. Un email ne remplace pas cette preuve.
5. **Un seul Durable owner.** Le Workflow complet possède la Delivery ; l’adapter ne fait que classer une tentative. Pas de Queue/DLQ notifications et pas d’extraction `@kit/jobs` dans ce périmètre. ADR-0018 reste autoritaire.

## Contrat public

Ces signatures spécifient l’interface à implémenter, pas un Package déjà livré. La racine est serveur uniquement. Le browser utilise les routes App, jamais ce Package ou son schéma.

### Racine `@kit/slack`

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

| Précondition / résultat | Contrat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session                 | `sessionId` est lu côté serveur Better Auth ; `userId` est celui de cette session pour une liaison. Aucun User ID browser/state ne remplace cette autorité. L’App vérifie session, Organization active, membership et capability avant l’opération HTTP.                                                                                                                                                                                                                                                                                                                        |
| Installation            | Predicates/CAS sur `(orgId,installationId,generation)` ; référence absente/périmée → `installation_unavailable`. Un ID seul ne donne aucune autorité cross-org.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Temps/réseau            | `now()` et données persistées en epoch **ms** ; JWT et `retryAfterSeconds` en **secondes**. Requêtes avec timeout 10 s, hôtes/endpoints fixes et `redirect:'error'`. Aucun claim/paramètre client ne choisit une URL de fetch.                                                                                                                                                                                                                                                                                                                                                  |
| Erreurs                 | Erreurs attendues dans `SlackOutcome` ; `providerCode` filtré `[a-z0-9_]{1,64}` ou `unknown_error`, jamais texte/corps provider/email/token. Erreurs DB/programming inattendues restent exceptions, pas succès/permanence métier devinée.                                                                                                                                                                                                                                                                                                                                       |
| Effets                  | `resolveUser` ne crée ni Notification ni Delivery ; `postMessage` ne choisit pas le User d’App ni une règle. Pour `kind:'user'`, il reçoit le User App courant, résout/revalide lui-même l’identité immédiatement avant `conversations.open`/POST ; un `slackUserId` issu d’un ancien préflight n’est pas accepté comme adresse autoritaire. Identité devenue indisponible après préflight → `permanent/identity_unavailable`, aucun POST ; sinon le bot de l’installation poste vers l’identité courante validée. `ts` reste une string receipt, pas une preuve d’idempotence. |

`completeAuthorization` fournit `linkedSlackUserId` seulement pour `user_link`. Construction : configuration OAuth complète, redirect URIs HTTPS exactes et trousseau valide requis. L’App ne sérialise jamais ces options dans ses erreurs.

### `@kit/slack/notifications` : interface spécialisée, cœur minimal

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

Aucun champ Slack n’est imposé au cœur ; tous les imports de `@kit/notifications` sont `import type`. L’adapter utilise `orgId` du même input que l’installation, impose le rendu et retourne les trois résultats partagés. `deliveryId` sert à corréler, pas à dédupliquer chez Slack.

| Préflight / résultat                                                   | Traitement                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User sans correspondance, installation inactive, destination supprimée | Le service App écrit `skipped` **avant** Channel. Aucun quatrième résultat ou faux `sent`.                                                                                                                                                                                                                                                        |
| `resolveUser → linked`                                                 | Préflight App `ready`, génération courante et `target:{kind:'user',user}` où `user` vient d’être relu côté App. Le `slackUserId` retourné n’est ni un checkpoint d’autorisation ni l’adresse d’un prochain POST : `postMessage` revalide l’identité courante. `unmapped` → `unavailable` ; erreur transitoire → `retryable`, pas « aucun match ». |
| Slack accepte le POST                                                  | `sent` signifie acceptation transport, pas lecture/réception finale par le User.                                                                                                                                                                                                                                                                  |
| Succès rendu invalide                                                  | Aucun POST ; `permanent/payload_invalid`. Le renderer App et son catalogue restent propriétaires du contenu.                                                                                                                                                                                                                                      |

Le Workflow reçoit la référence stable `{orgId,kind:'user'|'organization',id}` de la Delivery, pas ce grand input ni un token. **Dans le callback de chaque tentative du step d’envoi, y compris retry natif**, l’App relit le User/email/emailVerified et les accès/règles courants, puis appelle le Channel ; Slack résout/revalide l’identité dans ce même chemin juste avant DM. Un résultat d’adresse, permission ou email obtenu dans un ancien step/checkpoint ne peut pas être réutilisé pour envoyer. En revanche, une reprise de persistance après un step d’envoi réussi ne doit pas reconstruire/réémettre cet effet réussi.

### Exports et dépendances

| Export            | Surface                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`               | `createSlack` et types ci-dessus, serveur uniquement ; aucune route Hono ni import App.                                                                                                                                                       |
| `./schema`        | `slackInstallations`, `slackUserLinks`, `slackOAuthTransactions`, `slackEmailMatches`, agrégat `slackDrizzleSchema` ; `SlackInstallationRow`, `SlackUserLinkRow`, `SlackOAuthTransactionRow`, `SlackEmailMatchRow` dérivés de `$inferSelect`. |
| `./notifications` | `createSlackNotificationChannel`, `escapeSlackText`, `SlackNotificationDelivery`, `SlackNotificationContent`.                                                                                                                                 |
| Privé             | AES-GCM, parsing/validation OAuth/OIDC/JWKS, repositories et plaintext. Aucun export `getToken` ou `call(method,args)`.                                                                                                                       |

Manifest ESM `{types,import,default}` comme les Packages voisins. Réutiliser `@kit/db`, Drizzle et Zod 4. `@kit/notifications` est peer workspace optionnel pour le sous-export, et dépendance de développement ; la racine n’exige pas son runtime. `jose` est direct pour JWS/JWKS ; aucun SDK Slack/Bolt, framework OIDC complet ou Package jobs supplémentaire.

## Schéma et lifecycle

### Tables de `./schema`

| Table                      | Champs et contraintes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack_installations`      | `id` PK ; `org_id NOT NULL UNIQUE`, `team_id NOT NULL UNIQUE` ; `team_name`, `app_id`, `bot_user_id`, `granted_scopes_json` ; `status active/revoked/disconnecting`, `status_reason NULL` dans les valeurs de `SlackInstallationStatusReason` ; `generation INTEGER NOT NULL` ; `token_ciphertext_json NULL` ; `created_at`, `updated_at` epoch ms. UNIQUE `(id,org_id)` ; `active` implique chiffré présent et reason null ; `disconnecting` implique chiffré conservé et reason `auth_indeterminate` ou `revocation_requested`. |
| `slack_user_links`         | PK `(installation_id,org_id,user_id)` ; `team_id`, `issuer`, `subject`, `slack_user_id`, `created_at`, `updated_at` ; FK composite installation/org. Aucun email ou token OIDC.                                                                                                                                                                                                                                                                                                                                                   |
| `slack_email_matches`      | PK `(installation_id,org_id,user_id)` ; `generation`, `email_fingerprint`, `slack_user_id`, `resolved_at` ; FK composite installation/org. Hint positif seulement, TTL maximal 300 000 ms, jamais preuve durable d’identité ; revalidation Slack avant chaque tentative DM même avant expiration.                                                                                                                                                                                                                                 |
| `slack_oauth_transactions` | `state_hash` PK ; `purpose`, `org_id`, `user_id`, `session_binding_hash`, `created_at`, `expires_at`, `nonce_hash NULL`, `installation_id NULL`, `generation NULL`, `expected_team_id NULL`. Pour `user_link`, ces dernières coordonnées et nonce sont obligatoires. Consommation atomique delete/returning ou CAS équivalent.                                                                                                                                                                                                    |

Pas de FK vers User, membership, source Product ou table notifications : les FKs sont internes et org-scopées. L’App compose le schéma, applique le SQL via le catalogue selon ADR-0008/0012 et purge les données Slack au lifecycle User/Organization. Les transactions OAuth expirées sont inertes ; leur nettoyage ne réveille aucune exécution.

`team_id UNIQUE` vaut dans ce Deployment/DB, pas entre Deployments indépendants. `revoked` et `disconnecting` réservent encore leur workspace, jusqu’à déconnexion terminée.

### Configuration des Organization destinations : un seul propriétaire

`@kit/notifications/schema` possède `kit_notification_destinations(org_id,channel,external_id,selector,…)`. Slack n’a **pas** de seconde table de destinations/sélecteurs.

- Pour `channel='slack'`, `external_id = JSON.stringify(['slack',installationId,slackChannelId])`. Tuple déterministe, sans credential ou génération ; la génération est résolue courante à chaque tentative.
- Une ligne = une adresse et un sélecteur type/catégorie/`*`, avec UNIQUE `(org_id,channel,external_id)` : plusieurs destinations distinctes sont possibles, pas plusieurs subscriptions de la même adresse. Un changement de sélecteur remplace celui de cette adresse.
- Changement de sélecteur conserve l’identité ; changement de canal/installation est **suppression+création**, pas redirection d’une ancienne Delivery.
- À la tentative, recharger la référence encore configurée et son installation actuelle. Une destination pointant vers une installation supprimée est `unavailable`, puis `skipped`, jamais ressuscitée par une connexion de nouvel ID.
- Les Deliveries historiques restent conservées par notifications ; aucun cycle FK notifications ↔ Slack.

### Transitions

| Opération                                                                       | Transition et fence                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation initiale acceptée                                                  | Nouvel ID, génération 1, token chiffré, `active` ; unicités org/team appliquées au commit.                                                                                                                                                                                                                                         |
| Réinstallation du même workspace dans la même Organization                      | Même ID, `generation+1`, nouveau token/chiffré/AAD, `active` ; caches email et transactions en attente invalidés. Les liaisons OIDC du même workspace peuvent rester.                                                                                                                                                              |
| `token_revoked` prouvé, compte/workspace définitivement inactif ou token expiré | CAS `(orgId,id,generation,status='active')→revoked`, reason respectivement `token_revoked`, `account_inactive` ou `token_expired` ; seul le premier prouve une révocation distante. Credential définitivement inutilisable écarté, pas de refresh. Une réponse d’ancienne génération ne modifie jamais la nouvelle.                |
| `invalid_auth` ambigu sur n’importe quel appel bot                              | CAS `active→disconnecting`, `statusReason:'auth_indeterminate'`, **sans changer génération/AAD ni supprimer le chiffré**. Credential suspendu localement, conservé pour révocation seulement ; aucun envoi ou retry autonome, révocation admin encore possible après correction IP. Ce n’est pas la preuve d’une révocation Slack. |
| Déconnexion demandée                                                            | CAS vers `disconnecting`, `statusReason:'revocation_requested'`, **sans changer la génération liée à l’AAD** ; aucun nouvel envoi. Chiffré gardé pour révocation seulement ; réinstallation refusée tant que déconnexion non terminée.                                                                                             |
| Révocation confirmée                                                            | Supprimer token/connexion, liaisons/caches/transactions internes ; historique notifications conservé et unicité team libérée. Un retry admin terminé ne cible jamais une nouvelle connexion.                                                                                                                                       |

Changer de workspace demande déconnexion puis nouvel ID d’installation. Aucun ancien Slack user ID ou canal n’est réinterprété dans l’autre workspace. Les actions admin portent l’ID et la génération attendus.

Les noms d’état existants sont conservés, mais `revoked` décrit un état local désactivé : le DTO/UI utilise obligatoirement `statusReason` pour ne pas affirmer une révocation distante sur compte inactif ou expiration. `disconnecting/auth_indeterminate` s’affiche « connexion suspendue, authentification indéterminée ; token conservé pour révocation », avec action admin de correction/réessai de révocation, pas « révoquée chez Slack ». Aucun nouvel état caché ou réactivation automatique.

## OAuth v2 confidentiel et state

`POST authorize → state persisté → navigation Slack → GET callback → guards revérifiés → state consommé → code échangé → réponse validée → chiffrement/commit → audit → 303 App fixe`.

1. State CSPRNG **32 octets**, base64url, TTL **600 s** ; SHA-256 stocké avec purpose, Organization, User et hash du `session.id` Better Auth. Pas de state signé réutilisable ou d’autorité choisie par le client. Consommation atomique unique, y compris refus utilisateur ; callbacks concurrents ne peuvent réussir deux fois.
2. L’App obtient l’ID de session côté serveur depuis son instance Better Auth. Le `SessionPort` fournit cet ID via `sessionId` ; pas de refonte globale ou de hash d’un cookie refreshable à la place.
3. Endpoints fixes `https://slack.com/oauth/v2/authorize` et `POST https://slack.com/api/oauth.v2.access` ; authentification confidentielle `client_secret_basic`, corps form-urlencoded, redirect URI HTTPS **identique** aux deux étapes. Aucun client secret côté SPA.
4. Contrôler HTTP et `ok`, forme, bot `token_type`, token non vide, `app_id` attendu, `team.id`, scopes requis. **Rejeter toute Enterprise Grid**, pas seulement l’installation org-wide : `is_enterprise_install` doit être `false`, `enterprise` explicitement nul ; valeur/métadonnée ambiguë échoue fermée. Refuser aussi `expires_in`/`refresh_token` signalant la rotation Slack non gérée.
5. La contrainte unique workspace arbitre les callbacks de deux Organizations. Conflit public sans divulguer l’autre Organization. **Ne jamais révoquer aveuglément le token d’une réponse refusée**, potentiellement déjà celui de la connexion légitime. Après consommation state, erreur d’échange/commit → nouveau parcours utilisateur, pas replay automatique du code.

### PKCE

Mode choisi : client **confidentiel Worker**, redirect HTTPS et secret serveur. Le mode PKCE documenté par Slack marque l’app comme public client, est irréversible sans support et comporte des contraintes de redirects/rotation. Il n’est **pas activé en V0**.

Un paramètre `code_verifier` documenté ne prouve pas un mode S256 confidentiel sans cette activation. State et nonce restent obligatoires ; aucun downgrade silencieux ni refresh n’est introduit. Toute activation future doit prouver le mode Slack exact avant évolution du contrat.

## Liaison OIDC explicite

### Parcours et provenance

- Session App préexistante, propre User, `purpose='user_link'`. State et nonce indépendants de **32 octets**, TTL 600 s, transaction liée à session/User/org/installation/génération/workspace.
- `https://slack.com/openid/connect/authorize`, `response_type=code`, `scope=openid`, hint `team` de l’installation et redirect URI distincte. Mode callback **query**, conforme à la discovery Slack courante et `SameSite=Lax`.
- Échange serveur `POST https://slack.com/api/openid.connect.token`, `grant_type=authorization_code`, client authentifié et même redirect URI. N’accepter que l’`id_token` de **cette réponse directe**, jamais un JWT du browser, d’un événement ou d’un cache désigné par le client.
- Le token OIDC utilisateur n’est pas le bot token. Aucun token OIDC n’est conservé après validation, aucun compte/session App n’est créé. Email/nom/avatar ne déterminent pas l’identité.

### Validation obligatoire avant écriture

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

Configurer `jwtVerify` avec issuer, audience, `algorithms:['RS256']`, claims requis, date courante et tolérance. Le Package complète nonce, workspace, multi-audience, `iat` lié à la transaction et `at_hash` ; schéma des claims validé avant usage métier.

JWKS : fetch injecté à URL fixe, redirects refusés, cache maximal 10 min, cooldown 30 s, timeout 5 s. Cache sans credential, non Durable owner. Aucune clé vérifiable → aucune liaison ; pas de fallback `decodeJwt` ou de désactivation de signature.

**TLS ne supprime pas la validation.** OIDC Core §3.1.3.7(6) permet, dans le seul cas d’un ID token reçu directement du token endpoint, d’utiliser la validation TLS du serveur à la place de la signature. Les claims/audience/temps/nonce/sujet/workspace/session restent obligatoires. Cette ADR n’utilise pas la dérogation : **signature et claims** sont vérifiés.

**Preuve fournisseur encore requise :** token réel de test obtenu avec `openid` seul et portant le claim workspace requis. Les exemples Slack emploient aussi `profile email` sans garantir ce jeu minimal. S’il manque, échouer fermé ; ne pas élargir les scopes ou inférer le workspace depuis le hint sans évolution explicite du contrat.

## Email et unlink

| Situation      | Traitement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liaison OIDC   | Prioritaire même si emails différents. Un échec DM ne permet jamais un fallback email vers une autre personne ; délier/relier explicitement.                                                                                                                                                                                                                                                                                                                                                   |
| Sans liaison   | User persisté fourni par App après guards ; `emailVerified===true`, email non vide, normalisation `trim().toLowerCase()` actuelle de `@kit/auth`, sans heuristique alias/Gmail/domaine.                                                                                                                                                                                                                                                                                                        |
| Lookup courant | `users.lookupByEmail` avec bot de l’installation ; vérifier `user.id`, `team_id` attendu, `deleted:false`, `is_bot:false`, `is_app_user:false` et `profile.email` normalisé égal à l’email App courant vérifié. Réponse absente/incomplète n’autorise aucun DM. `users_not_found` couvre aussi désactivé → `unmapped` puis `skipped` au préflight. Réseau/429 reste `retryable`.                                                                                                               |
| Cache-hint     | Positif, installation/org/User + génération et SHA-256 du tuple `(orgId,installationId,userId,emailNormalisé)` ; TTL **5 min maximum** depuis `resolved_at`, date future/expirée invalide. Le fingerprint reste une donnée personnelle et ne constate **pas** un changement d’email côté Slack. Même un hint frais ne peut autoriser un POST sans revalidation fournisseur courante. Changement email App/perte de vérification/réinstallation invalide le hint ; aucun cache négatif durable. |
| Déliaison      | Supprimer liaison explicite **et** cache du User courant, puis matching email de nouveau possible. Aucun `auth.revoke` sur le bot ; audit `slack.user_unlinked`. Ce n’est pas un opt-out Slack.                                                                                                                                                                                                                                                                                                |

Avant **chaque** tentative DM par email, `postMessage` recharge la liaison/cache de son installation et revalide le hint avec `users.info(user=cachedSlackUserId)` : ID attendu, workspace, humain actif et `profile.email` normalisé égal à l’email App vérifié courant. Les scopes `users:read` et `users:read.email` déjà requis couvrent cette lecture. Cache absent/expiré, réponse d’identité absente/inactive, email changé/manquant ou mismatch team → invalider le hint et effectuer **au plus un** lookup email frais avant tout POST ; seule une identité actuelle entièrement validée peut recevoir le DM. Une panne/429 de revalidation donne `retryable`, jamais validation par défaut ni fallback déclenché par une panne.

Si l’email App `e` passe de Slack `S1` à `S2`, `users.info(S1)` révélant son nouvel email interdit le POST à `S1`, même si ce compte est actif et accepterait le message ; le lookup actuel peut fournir `S2`. Les 5 min ne sont **pas** une fenêtre autorisant une identité périmée : elles bornent seulement la réutilisation du hint, chaque réutilisation étant revalidée. Une course fournisseur entre cette dernière lecture et le POST reste non atomique ; aucune garantie instantanée inter-services n’est prétendue.

Après une erreur d’identité du POST, invalider le hint sans second POST ou relookup/resend en boucle pendant cette tentative. Seule une nouvelle tentative du Workflow peut relire tous les accès et résoudre à nouveau. Ni 429 ni 5xx n’invalident seuls une identité, et une liaison OIDC explicite ne bascule jamais sur email ; ses emails peuvent intentionnellement différer.

L’UI explique « délier ; la correspondance email automatique reprend ». Couper le Channel utilise une Notification rule, sous locks. Unicité par `(installation,User)` seulement ; aucune unicité inverse implicite Slack user ID. `emailVerified` vaut la preuve produite par l’App : la création admin actuelle peut prévalider un User ; ce contrat ne prétend pas prouver universellement la possession de sa boîte et ne refond pas auth.

## Coffre AES-GCM

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

| Élément         | Contrat                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clés            | AES-GCM 256 bits CSPRNG dédiée, import non extractible encrypt/decrypt ; IDs courant/précédent distincts. Aucun dérivé de `client_secret` ou `BETTER_AUTH_SECRET`. L’App mappe les secrets Worker vers le trousseau ; aucun binding global lu par le Package.           |
| IV/tag          | IV **12 octets** CSPRNG neuf à chaque chiffrement/rechiffrement/réinstallation ; tag **128 bits**. Base64url d’IV et de `ciphertext                                                                                                                                     |     | tag` WebCrypto. Aucun IV dérivé de timestamp/orgId. |
| AAD             | UTF-8 `JSON.stringify(['@kit/slack',1,'bot-token',deploymentId,orgId,installationId,teamId,generation,kid])`, ordre fixé. Reconstituer depuis les coordonnées attendues, pas seulement celles du blob. Copier vers autre org/install/team/génération/Deployment échoue. |
| Déchiffrement   | `kid` sélectionne une clé exacte, pas un essai de toutes. Version/alg/kid/IV/tag/AAD invalides → `permanent/secret_unavailable`, aucun envoi, diagnostic redacted ; pas une révocation supposée chez Slack.                                                             |
| Rotation coffre | Écrire courante, lire précédente. La précédente n’est retirée qu’après rechiffrement CAS/reconnexion des lignes et prise en compte des backups requis ; finir ce passage avant rotation suivante. Pas de Cron/moteur de rotation/reprise supplémentaire.                |

Rotation coffre ≠ rotation token Slack. Perte des clés → réinstallation. AES-GCM ne protège pas d’un Worker compromis disposant des secrets ou d’un rollback complet de données valides. Aucun plaintext dans cache process, payload durable, URL, exception/cause/trace fetch/audit/UI ; seules les clés non extractibles peuvent être réutilisées entre appels. Aucun cache mutable de tokens multi-Organization.

## Classification et déconnexion

### Une tentative

| Observation                                                                                               | Résultat / effet                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 2xx, JSON `ok:true`, `channel`/`ts` valides                                                          | `ok(receipt)→sent` ; HTTP 200 seul ne suffit pas.                                                                                                                                                                                                                                                                                                                                                                                     |
| HTTP 429 ou `ok:false,error:'ratelimited'`                                                                | `retryable/rate_limited` ; parse strict digits en entier sûr ≥0 de `Retry-After`, 0 normalisé 1 s, absent/invalide omis. Pas d’invalidation d’identité ou destination.                                                                                                                                                                                                                                                                |
| 5xx/408/réseau/timeout, `service_unavailable`, `internal_error`, `fatal_error`                            | `retryable`, effet distant possiblement ambigu et doublon possible au prochain POST.                                                                                                                                                                                                                                                                                                                                                  |
| `invalid_auth` sur tout appel **bot**                                                                     | `permanent/auth_indeterminate` pour la tentative ; CAS de cette génération `active→disconnecting`, reason `auth_indeterminate`, token chiffré conservé et désactivé pour révocation admin seulement ; audit `slack.auth_disabled` une fois, prochaines Deliveries `skipped` au préflight. Une restriction IP peut laisser ce token valide ailleurs : ni suppression ni affirmation de révocation distante. Erreur OIDC ≠ état du bot. |
| `token_revoked`, `account_inactive`                                                                       | `permanent/auth_revoked`, CAS `active→revoked` avec reason exacte et credential inutilisable écarté ; `token_revoked` peut produire `slack.revoked`, l’inactivité produit `slack.auth_disabled`, pas une fausse preuve de révocation distante. Prochaines Deliveries `skipped`.                                                                                                                                                       |
| `token_expired`                                                                                           | `permanent/token_expired`, désactivation/revoked local, reason `token_expired`, audit `slack.auth_disabled` ; pas de refresh ou claim de révocation distante.                                                                                                                                                                                                                                                                         |
| `channel_not_found`, `is_archived`, `not_in_channel`, `restricted_action`, `no_permission`, User invalide | `permanent/destination_invalid`, Delivery `failed` et diagnostic destination ; pas de révocation globale/join automatique. Invalidation email seulement selon contrat ciblé.                                                                                                                                                                                                                                                          |
| `missing_scope`                                                                                           | `permanent/missing_scope`, configuration/réinstallation ; pas une révocation.                                                                                                                                                                                                                                                                                                                                                         |
| `invalid_blocks`, `invalid_arguments`, `no_text`, rendu invalide                                          | `permanent/payload_invalid`, zéro réseau si rejet local ; pas de retry du même payload malformé.                                                                                                                                                                                                                                                                                                                                      |
| `users_not_found` au matching                                                                             | `ok(unmapped)` puis `skipped` avant Channel, pas une panne provider.                                                                                                                                                                                                                                                                                                                                                                  |
| 2xx invalide ou receipt manquante                                                                         | `retryable/invalid_response`, jamais `sent`.                                                                                                                                                                                                                                                                                                                                                                                          |
| Autre 4xx/code inconnu                                                                                    | `permanent/provider_error`, code filtré ou `unknown_error`, diagnostic visible ; pas de boucle infinie ou `skipped` silencieux.                                                                                                                                                                                                                                                                                                       |

HTTP et corps Slack `ok:false` sont vérifiés séparément. Une exception infrastructure inconnue n’est jamais transformée en erreur permanente en devinant depuis son message.

### `Retry-After` et Workflow

- L’adapter ne dort pas, ne rappelle pas `send`, ne choisit pas le nombre de reprises et ne publie pas d’exécution de remplacement. **Le Workflow complet de Delivery est l’unique Durable owner**, avec ses steps/checkpoints/retries/sleeps natifs.
- Le hint Slack n’a pas de plafond fournisseur 24 h établi. Un `Retry-After` valide est un **minimum**, jamais clampé vers une tentative plus tôt. Si l’owner borne ses attentes à 24 h et reçoit `retryAfterSeconds>86400`, il termine `failed` avec diagnostic `retry_after_exceeds_budget`, sans nouvel envoi, sans remise en admission ou chaîne d’instances pour contourner le budget.
- Slack limite méthode/workspace/app et `chat.postMessage` généralement 1 message/s par canal. Le `Retry-After` affecte cette méthode/workspace, pas tous les workspaces. Aucun ordonnanceur global durable 1/s n’est promis par ce Package ; les 429 restent autoritaires.
- Le receipt réussi et la finalisation D1 sont des étapes distinctes du Workflow ; un échec de finalisation ne doit pas rejouer un POST déjà checkpointé. Si Slack a accepté puis que la tentative perd sa réponse/checkpoint, un doublon reste possible.
- Aucun argument public de déduplication n’est documenté pour `chat.postMessage`. `deliveryId`/`ts` ne donnent pas exactly-once. L’ID stable du Workflow supprime la double admission de la même Delivery, pas l’ambiguïté d’un effet fournisseur déjà accepté sans preuve persistée.

### Déconnexion admin

| Après passage local `disconnecting`                           | Traitement                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.revoke → ok:true,revoked:true`                          | Confirmation, suppression token/connexion et audit de déconnexion terminée.                                                                                                                                                                                                                   |
| Token déjà révoqué ou compte/workspace définitivement inactif | Terminaison locale idempotente ; pas de réactivation ou retry de credential inutilisable.                                                                                                                                                                                                     |
| 429/réseau/timeout/5xx                                        | Garder le token **chiffré et désactivé**, usage révocation uniquement ; retour d’échec, UI `disconnecting`, nouvelle tentative admin explicite. Aucun retry autonome.                                                                                                                         |
| `invalid_auth` ou réponse non concluante                      | Ne pas annoncer révocation distante : restriction IP possible. Garder `disconnecting`, reason `auth_indeterminate` si ce code est observé, chiffré désactivé et diagnostic borné pour correction/réessai admin. Même règle de rétention sur tous les appels bot, pas seulement `auth.revoke`. |

Déchiffrer `disconnecting` est autorisé uniquement pour cette révocation, jamais pour poster. Un retry HTTP après suppression locale ne peut viser un nouvel ID de connexion. Aucun effacement local n’est présenté comme révocation distante pendant une panne indéterminée.

## Block Kit et rendu

Sous-ensemble **fixé** : `section`, `header`, `context` textuel, `divider`. Aucun passthrough `unknown[]`, image/fichier, interactivité/modal/bouton d’approbation Slack. Le lien mène à l’App et ses guards.

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

1. L’App rend dans sa locale par défaut **au moment de la tentative**, avec son catalogue ; aucun texte métier/localisé dans le Package.
2. Après schéma strict, borner chaque texte à **son composant**, fields/context à 10, contenu à 49 blocs avec lien. Structures vides/malformées après normalisation : rejet, pas confiance dans la troncature Slack.
3. Lien séparé : href HTTPS absolu sur origin App allowlistée, sans credentials/query de capability/token ; label catalogue. Réserver `<href|label>`, séparateur et ellipse avant troncature. Ajouter fallback **et** dernière section, même sans autres blocks. Lien trop long pour section3000 → erreur, jamais URL coupée/lien supprimé.
4. Comptage conservatif en unités UTF-16 **finales échappées**, pas de paire surrogate coupée ou troncature JSON. Retirer un jeton Slack `<…>` terminal incomplet avant ellipse/lien. Ne pas importer la limite RTM 16 KiB dans HTTP.
5. `escapeSlackText` échappe `&`, `<`, `>` des valeurs non fiables avant interpolation mrkdwn. Envoyer `verbatim:true`, `parse:'none'`, `unfurl_links:false`, `unfurl_media:false` ; ces flags ne neutralisent pas seuls une mention brute `<!channel>`.

## Organization destinations et ceiling

| Cible                    | Admission/recheck                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM User                  | User IDs serveur après ACL objet à l’émission ; Organization active, membership et Module effectifs ; Inbox toujours créée puis résolution des Channels externes. Adresse après règles.                                                             |
| Organization destination | Fan-out **indépendant, une fois par émission/cible, même zéro User admissible** ; aucun faux User ou Inbox. Type déclare Slack et `organizationDestinations:true`, destination/sélecteur présents, Organization active et Module disponible/activé. |
| Plafond Deployment       | Règle la plus spécifique type > catégorie > `*`. Locked-off Slack interdit le collectif ; off non locked est un défaut User, pas veto contre l’opt-in collectif. Locked-on ne crée ni destination/opt-in ni accès Module.                           |
| Autres rules             | Organization/User rules des Users ne gouvernent pas cette cible collective. Ne pas choisir un auteur/admin/premier User pour lui appliquer ses préférences. Les DM suivent les trois niveaux de règles du contrat notifications.                    |
| Tentative                | Recharger destination/installation/statut/génération, type/opt-in/Channel, sélecteur, Module et plafond courants. Interdiction observée au dernier recheck → `skipped`. Une transaction D1 n’annule pas un POST déjà accepté.                       |

Le Notification producer fournit seulement User IDs/source autorisés, jamais une destination. Le fan-out n’est pas un effet de la première Inbox et est dédupliqué lors du replay de l’émission. `actorId`, seulement s’il est fourni, exclut ce User, jamais le collectif. Pour `flows.approval_requested`, aucun actorId : l’owner qui lance un run solo n’est pas exclu implicitement.

Opt-in est une exposition collective : invités et Slack Connect peuvent lire, sans membership App ni ACL par lecteur Slack. `tasks.assigned` n’est **jamais** éligible, y compris via catégorie/`*` ; `flows.approval_requested` l’est avec contenu minimal, sans arguments/outils/prompts/receipts/secrets. Le clic requiert session/autorisation App.

À lecture/envoi, membership/Module sont courants ; l’ACL objet n’est pas relue. Le snapshot autorisé à l’émission peut rester visible/envoyé après perte de cette ACL, avec clic 404. Slack n’ajoute pas ce contrôle implicitement.

## Routes, guards et audit

### HTTP App

Base `S=/api/orgs/{orgId}/slack`. `createRoute`, schémas stricts et OpenAPI. Listes `{items,nextCursor,requestId}`, autres JSON avec `requestId`, callbacks 303 et erreurs documentés. Erreurs Kit : 400 validation, 401 session absente, 403 credential/capability, 404 hors scope, 409 conflit workspace/génération, 500 infrastructure scrubbed. Aucun nouveau endpoint public d’émission/login/replay.

| Route installation              | Entrée                                 | Sortie / autorité                                                                                                            |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET S/installation`            | —                                      | `{installation:SlackInstallationView                                                                                         | null,requestId}` ; session/org/`manage_notifications`, sans chiffré/kid. |
| `POST S/installation/authorize` | `{}`                                   | `{authorizationUrl,expiresAt,requestId}` ; même autorité + Origin ; pas d’audit de connexion avant commit.                   |
| `GET S/installation/callback`   | `state` + exactement `code` ou `error` | 303 écran org fixe ; session/org/capability **mutation** revérifiée et purpose installation.                                 |
| `DELETE S/installation`         | `{installationId,generation}`          | `{disconnected:true,requestId}` après confirmation, ou erreur explicite et `disconnecting` persisté ; mêmes guards + Origin. |
| `GET S/channels`                | `limit?,cursor?`                       | Page `SlackChannelView` ; même autorité. Publics et privés où bot invité, archivés exclus, pas IM/MPIM.                      |

Les Organization destinations utilisent uniquement les routes génériques ci-dessous, session/org/`manage_notifications` et Origin sur mutations. **Aucune seconde route `S/destinations` ou PATCH Slack**. La création décode/valide `externalId`, exige l’installation active de cette Organization et appelle `checkChannel` ; type opt-in et plafond sont vérifiés serveur. Doublon `(orgId,channel,externalId)` →409, ressource étrangère →404, historique conservé.

| Route générique                                                      | Entrée                                 | Sortie                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/orgs/{orgId}/notification-destinations`                    | `limit?,cursor?`                       | Page de `{id,channel,externalId,selector,createdAt,updatedAt}`.                                                  |
| `POST /api/orgs/{orgId}/notification-destinations`                   | `{channel,externalId,selector}` strict | 201 `{destination,requestId}`, même DTO. Pour Slack, `externalId` est exactement le tuple JSON défini plus haut. |
| `PUT /api/orgs/{orgId}/notification-destinations/{destinationId}`    | `{selector}` strict                    | 200 `{destination,requestId}`, même DTO ; identité canal/installation immuable.                                  |
| `DELETE /api/orgs/{orgId}/notification-destinations/{destinationId}` | Aucun body                             | 200 `{ok:true,requestId}`.                                                                                       |

Le contrôle Slack utilise le bot de la même installation via `conversations.info`, refuse canal archivé, IM/MPIM ou privé inaccessible au bot ; un canal public peut utiliser `chat:write.public` sans invitation. Aucun canal ou secret ne provient d’un nom/URL client non validé. La disponibilité affichée est dérivée de l’installation et du diagnostic local, sans boucle de probes fournisseur à chaque liste.

| Route personnelle          | Entrée                                 | Sortie / autorité                                                             |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `GET S/me/link`            | —                                      | `{source:'oidc'                                                               | 'email' | 'none',slackUserId?,reason?,requestId}` ; session + membership réelle ; pas email, capability admin ou bypass support. |
| `POST S/me/link/authorize` | `{}`                                   | `{authorizationUrl,expiresAt,requestId}` ; même scope + Origin, User session. |
| `GET S/me/link/callback`   | `state` + exactement `code` ou `error` | 303 Settings fixe ; session/membership/purpose + OIDC complet.                |
| `DELETE S/me/link`         | —                                      | `{unlinked:true,requestId}` ; même scope + Origin, aucun User ID client.      |

`selector` reprend `{kind:'type',value:string}`, `{kind:'category',value:string}` ou `{kind:'all'}` du cœur notifications. Le serveur ne propose/accepte que les types opt-in disponibles ; admission/recheck filtrent aussi les catégories/`*`, pas seulement l’écran.

Destinations persistées : `ListQuery`, limite 1…100/default50, cursor≤512, keyset exact `{createdAt,id}` décroissant après scope org. Canaux : cursor opaque validé contenant installation/génération et cursor Slack ; référence périmée refusée, jamais choix de token. Relayer une page `conversations.list(public_channel,private_channel,exclude_archived:true)`, sans charger toute la liste pour fabriquer un keyset. Une page vide peut avoir un next cursor provider. Paramètre répété →400.

### Guards actuels à prolonger

- `requireAuth` puis `requireSession`, y compris GET : le second exige `authMethod==='session'`, il ne résout pas lui-même une identité. Aucune `sk_` sur routes Slack V0.
- Admin : `requireOrgContext` + `requireOrgCapability('manage_notifications')`, minimum `admin`. Ajouter cette capability à `OrgCapability/CAPABILITY_MIN` **et** aux unions littérales `@kit/auth/hono` et wrapper App `middleware/org-context.ts` ; pas une seule surface migrée.
- Cross-org/ressource étrangère →404 ; Organization inactive suit refus existant ; `member`/`reader` →403 admin ; `staff` ne gagne pas un accès org par son seul Platform Role.
- Support `super_admin` : lecture uniquement par opt-in explicite et journalisation existants ; écriture par mécanisme break-glass existant, jamais un nouveau paramètre client. **Callback GET écrit** : il ne reçoit pas l’autorité de lecture via `isSafeMethod/allowSuperAdmin` ; appliquer policy mutation explicite ou exiger membership réelle sans bypass.
- Liaison User : propre session et membership réelle. Aucun nouveau Module `slack` inventé ; le Module des Notification types reste le plafond d’émission/envoi, jamais un verrou Inbox externe.

Mutations browser sous Origin guard existant. Callbacks GET : session+state, pas d’exigence Origin Slack ; ne pas désactiver CSRF ou élargir cookies pour un ancien exemple `form_post`. Redirects/origins App depuis configuration serveur, pas `Host`/`Origin`/`returnTo` client. Données personnelles sans cache public ; callback `Cache-Control:no-store`, `Referrer-Policy:no-referrer`, aucune resource tierce avant redirection et aucun log de query code/state.

### Audit

| Actions                                                                               | Acteur / meta allowlist                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack.connected`, `slack.disconnect_requested`, `slack.disconnected`                 | User admin réel ; org/installation en colonnes dédiées ; `{generation,reason?}`.                                                                                                      |
| `slack.revoked`                                                                       | Acteur null ; CAS par génération, uniquement révocation fournisseur prouvée, une émission ; `{generation,reason,statusReason}`, jamais nouvelle connexion visée par ancienne réponse. |
| `slack.auth_disabled`                                                                 | Acteur null ; suspension locale sur `invalid_auth`, inactivité ou expiration, CAS/audit une fois ; `{generation,reason,statusReason}`. Jamais synonyme de révocation distante.        |
| `slack.destination_created`, `slack.destination_updated`, `slack.destination_deleted` | User admin réel ; destination en target ; `{installationId,slackChannelId,selectorKind,selectorValue?}`.                                                                              |
| `slack.user_linked`, `slack.user_unlinked`                                            | User session/subject ; installation en target ; `{installationId,subjectUserId,method}`. Un cache email n’est pas un consentement explicite fictif.                                   |

Étendre actions **et** chaque `META_ALLOW` App : une action absente de la map actuelle n’a pas l’allowlist stricte attendue. Jamais token/chiffré/email/state/nonce/code/JWT/corps provider dans meta/erreur/URL finale.

Les transitions OAuth/OIDC, liaison et révocation Slack conservent le modèle d’audit App **best-effort**, sans prétendre à une transaction atomique Slack/D1/audit. `audit` est appelé après transition locale et son échec ne répète jamais l’effet Slack ; log action/requestId et erreur scrubbed, sans dump d’exception contenant des credentials.

**Exception locale explicite :** la configuration des Organization destinations appartient à notifications et sa mutation D1 est atomique avec son audit obligatoire, comme les Notification rules admin. Ses repository ports reçoivent l’audit dans `put/delete` ; aucune écriture de destination suivie d’un simple `appendAudit` best-effort. Une mutation effective sans audit ne peut être commitée ; un no-op ne crée pas d’événement fictif. Les actions destination du tableau sont produites par cette composition App, pas par le callback réseau `SlackOptions.audit`.

Audit listable au `super_admin` seulement. Le bypass org actuel est un log console structuré, pas automatiquement une ligne `audit_events`. L’admin Organization consulte les métadonnées Delivery de son scope, pas contenu/email ou autre Organization. UI : active/revoked/disconnecting avec `statusReason` obligatoire, suspension auth indéterminée distincte de révocation prouvée, correction IP puis retry admin de révocation sans perte du token, reconnexion seulement après déconnexion terminée, canal privé à inviter, refus Grid/conflit workspace/state expiré, unlink avec reprise email.

## Dépendance de sécurité et alternatives

| Option                                   | Conséquence / décision                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming webhook seul                    | Ne couvre pas DM et fige un canal ; refusé. Deux modes webhook+OAuth n’ont pas de besoin validé.                                                                                                |
| App-only / Slack dans notifications      | Répéter OAuth/coffre ou contaminer le cœur ; Package dédié retenu. Cette ADR justifie sa promotion avec un seul consommateur, selon la règle « deux consommateurs ou ADR acceptée » d’ADR-0001. |
| SDK Slack/Bolt ou framework OIDC complet | Pas nécessaire pour ce sous-ensemble HTTP ; n’élimine ni guards/coffre/règles. `fetch` suffit au transport.                                                                                     |
| Zéro bibliothèque JWS                    | WebCrypto permettrait le protocole maison, mais Kit posséderait alors parsing JWS, alg/kid/JWKS et gestion de clés ; ce risque ne disparaît pas en supprimant une ligne de dépendance.          |
| TLS sans signature                       | Exception OIDC étroite, toujours tous les claims ; non retenue pour éviter une policy fragile à la provenance du JWT.                                                                           |

**`jose` direct**, dernière stable revérifiée au registre le jour de l’ajout. Relevé du **2026-10-22 : 6.2.13**, ESM/WebCrypto, zéro dépendance runtime déclarée, MIT, Cloudflare Workers documenté. Le lock actuel contient `6.2.3` transitif via Better Auth/MCP : ni une déclaration directe ni la stable relevée. Déclaration/lock explicites, pas inventaire annoncé vide.

`jose` vérifie JWS/JWKS, pas session/org/state/nonce/workspace/AAD/guards/multi-audience/`at_hash`. Aucun de ces contrôles n’est remplacé par la seule présence d’une bibliothèque. Compatibilité Worker documentée ≠ smoke exécuté pour la compat date du consumer.

## Conséquences et preuves

| Conséquence                   | Limite assumée                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Petite interface réutilisable | Coffre, deux flux auth, tables/clé dédiée et dépendance sécurité directe à maintenir.                            |
| Sans Events API               | Révocation/canal cassé détectés à l’envoi, pas temps réel ; workspace réservé jusqu’à déconnexion.               |
| Unlink reprend email          | Pas d’opt-out fictif ; rules Slack/locks affichés séparément.                                                    |
| Workflow complet stable       | Pas de double owner ou Queue Delivery ; ambiguity fournisseur peut encore dupliquer un post accepté sans preuve. |
| Déconnexion indéterminée      | Aucun nouvel envoi local, token chiffré retenu tant que révocation inconnue, réessai admin explicite nécessaire. |

### Preuves requises avant livraison

| Groupe                             | Critères observables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth/OIDC                         | State rejoué/expiré/concurrent/autre session/org/purpose refusé ; membership/capability retirée avant callback refusée. Signature/alg/kid/iss/aud/azp/exp/iat/nbf/nonce/sub/team faux/absents ; JWKS indisponible fermé. Token de test `openid` seul avec team requis. Browser JWT seul ne crée pas une liaison.                                                                                                                                                                                                                    |
| Coffre/lifecycle                   | Courante/précédente, IV neuf, mauvais tag/kid/AAD org/install/team/génération/Deployment ; aucun plaintext DB/log/audit/payload durable. Conflit workspace concurrent sans révoquer la connexion légitime ; toute Grid refusée ; réponse ancienne génération sans impact nouveau token ; `auth.revoke` en panne garde `disconnecting` sans envoi/retry autonome.                                                                                                                                                                    |
| Accès/exposition                   | CP-IDOR/CP-UNAUTH par ressource, `sk_` refusées lectures/callbacks, member/reader/staff/support/break-glass exercés ; GET callback sans bypass lecture pour écrire. Type opt-in filtré serveur, catégorie/`*` ne rend pas tasks collectif ; fan-out une fois même zéro User, Inbox sans Delivery in_app, pas d’exclusion implicite de l’initiateur flows.                                                                                                                                                                           |
| Channel/rendu                      | 429/hints valides/invalides/>86400 sans envoi prématuré ; HTTP200 `ok:false`, receipt manquante, réseau/5xx ambigu, auth CAS/audit unique, destination invalide sans révocation globale. Email absence≠panne, OIDC jamais substitué. N/N+1 pour chaque borne, 50/51 blocs, section/fields/header/context, Unicode/mentions et lien conservé ; aucun import runtime notifications.                                                                                                                                                   |
| Composition/parcours               | Exports et schéma App, migration/catalogue, runtime Worker `jose` compatible ; étapes réussies Workflow non répétées à l’échec de finalisation ; OpenAPI/enveloppes/requestId ; navigateur installation/destinations/lien/unlink/reconnect/disconnect. Revue indépendante auth/isolation/credentials et Durable owner selon `AGENTS.md`, gates applicables du dépôt sans en réduire les exigences.                                                                                                                                  |
| Identité email — finding High      | Amorcer hint frais `e→S1`, changer seulement l’email Slack de S1 et attribuer `e` à S2 sans changer App/fingerprint/génération ; S1 reste actif et son POST accepterait. Avant DM, `users.info(S1)` invalide le hint : aucun POST S1, au plus un lookup courant, seul S2 validé peut recevoir. Couvrir TTL 300000 ms/expiration, email absent, team/bot/deleted, 429/timeout sans POST et sans fallback panne ; retry natif après ancien checkpoint doit recharger User et revalider dans le step d’envoi.                          |
| Auth indéterminée — finding Medium | Injecter `invalid_auth` sur `users.info`, lookup, DM et `auth.revoke` avec token encore valide depuis IP autorisée : CAS `disconnecting/auth_indeterminate`, chiffré inchangé et lisible avec son AAD, aucun nouvel envoi/refresh/retry autonome ; audit/UI sans claim remote-revoked. Après correction IP, l’admin peut appeler `auth.revoke` avec ce même credential puis l’effacer après confirmation ; réponse tardive ancienne génération sans impact nouvelle. Comparer `token_revoked` prouvé et ses reason/audit distincts. |

Ces preuves d’intégration restent à obtenir à l’implémentation. L’acceptation du contrat et les contrôles documentaires E0 ne prouvent pas une exécution Slack ou Workflow déployée.

## Références

### Architecture et décisions

- [ADR-0001](./0001-primary-axis-packages-compose-apps.md), [ADR-0003](./0003-multi-tenant-rbac-modules.md), [ADR-0008](./0008-kit-schema-identity-product-compose.md), [ADR-0012](./0012-kernel-persistence-request-context.md), [ADR-0018](./0018-durable-execution-ownership.md).
- [GLOSSARY](../../../../GLOSSARY.md), [Stack](../../standards/stack.md), [contrat HTTP](../../api-contract.md), [processus de revue](../../processes/dev-process.md).
- [Roxabi/roxabi-boilerplate-cf#461](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/461), [Roxabi/roxabi-boilerplate-cf#462](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/462), [Roxabi/roxabi-boilerplate-cf#458](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/458), [Roxabi/roxabi-boilerplate-cf#457](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/457).

### Sources fournisseur

| Contrat                 | Source primaire                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth/OIDC/scopes       | [Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack/), [openid.connect.token](https://docs.slack.dev/reference/methods/openid.connect.token/), [oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access/), [discovery](https://slack.com/.well-known/openid-configuration).                                                                                           |
| Validation ID token/TLS | [OIDC Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation), [§3.1.3.8](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowTokenValidation).                                                                                                                                                                                                                         |
| PKCE/révocation         | [PKCE](https://docs.slack.dev/authentication/using-pkce/), [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke/).                                                                                                                                                                                                                                                                                  |
| Identité/canaux/envoi   | [users.lookupByEmail](https://docs.slack.dev/reference/methods/users.lookupByEmail/), [users.info et email](https://docs.slack.dev/reference/methods/users.info/), [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).           |
| Auth indéterminée       | [Slack IP allowlist et `invalid_auth`](https://docs.slack.dev/concepts/security/#restrict-ip-addresses) : cette réponse peut signaler une IP refusée, sans invalider le token.                                                                                                                                                                                                                                    |
| Bornes Block Kit        | [Blocks](https://docs.slack.dev/reference/block-kit/blocks/), [Section](https://docs.slack.dev/reference/block-kit/blocks/section-block/), [Header](https://docs.slack.dev/reference/block-kit/blocks/header-block/), [Context](https://docs.slack.dev/reference/block-kit/blocks/context-block/), [Text object](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/).                    |
| Sécurité/runtime        | [Cloudflare WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [registre jose](https://registry.npmjs.org/jose/latest), [jose](https://github.com/panva/jose), [jwtVerify](https://github.com/panva/jose/blob/v6.2.13/docs/jwt/verify/functions/jwtVerify.md), [RemoteJWKSetOptions](https://github.com/panva/jose/blob/v6.2.13/docs/jwks/remote/interfaces/RemoteJWKSetOptions.md). |
