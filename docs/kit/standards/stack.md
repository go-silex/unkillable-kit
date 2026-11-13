# Stack normative du kit

> **Autorité :** ce document porte les choix de stack, leurs contraintes et leur rationale.
> `.dev/stack.yml` n'en est que la projection machine (paths, commandes et pointeurs).
> Les changements structurants exigent aussi un ADR sous [`../architecture/adr/`](../architecture/adr/).

## Stack complète (dernière révision 2026-10-03)

> **Contrat descriptif** : chaque ligne de livrable porte un **Statut**. Colonne « Quand » / priorité = **scaffold**.  
> `livré` = présent dans le code et `bun.lock` · `cible` = visé, pas livré · `option produit` = hors kit, un produit l'ajoute · `fermé` = décision close, non livré.  
> Colonne **Paquets** = paquets npm nommés par la ligne. Garde `bun run stack-contract:check` (kit) : `livré` ⇒ chaque paquet est dans `bun.lock` ; `cible` / `option produit` / `fermé` ⇒ absent (statut périmé sinon).  
> Bun + Turbo comme operator · Hono Workers · TanStack SPA · FastMCP · Better Auth cookies · erreurs centralisées · i18n FR.

### Principe

```text
API (Hono Worker)     = contrat unique pour web + MCP + skill
UI (Vite SPA TanStack)= client HTTP + cookies session
MCP                   = FastMCP (ou SDK) → même auth sk_ / même services
packages/*            = kit (0 string métier share)
apps/<product>-*      = produit (exclu à l’extraction)
```

Ce contrat est **publié** : `docs/kit/openapi/example-api.json`, projeté des routes (`createRoute` = validateur). Voir [API contract](../api-contract.md) et [ADR-0014](../architecture/adr/0014-openapi-from-hono-routes.md).

**shadcn (juil. 2026) :** default primitives = **Base UI** (`@base-ui/react`). Pin un engine dans `components.json`.  
Ref : [changelog Base UI default](https://ui.shadcn.com/docs/kit/changelog/2026-07-base-ui-default)

---

### A. Runtime & monorepo

| Couche          | Choix                                                                                                                                                                       | Quand | Statut | Paquets       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------------- |
| Language        | **TypeScript 7+ strict**                                                                                                                                                    | S0    | livré  | `typescript`  |
| Package manager | **Bun** workspaces (`bun.lock`)                                                                                                                                             | S0    | livré  |               |
| Task runner     | **Turborepo** (cache, filter, affected) — _pas_ remplacé par Bun                                                                                                            | S0    | livré  | `turbo`       |
| Edge            | **Cloudflare Workers**                                                                                                                                                      | S0    | livré  |               |
| API             | **Hono 4**                                                                                                                                                                  | S0    | livré  | `hono`        |
| Validation      | **Zod 4** (+ env schemas)                                                                                                                                                   | S0    | livré  | `zod`         |
| ORM             | **Drizzle** + **D1**                                                                                                                                                        | S0    | livré  | `drizzle-orm` |
| Bytes           | **R2**                                                                                                                                                                      | S0    | livré  |               |
| Jobs            | **CF Queues** + **Cron** — bindings bruts + démo `example-api` ; helper `@kit/jobs` = `cible` (§ H)                                                                         | M3+   | livré  |               |
| Deploy          | **Wrangler 4** · CD pull post-CI                                                                                                                                            | S0    | livré  | `wrangler`    |
| Types CF        | **`wrangler types`** runtime-only, `worker-configuration.d.ts` committé par app (`bun run types`) · `wrangler types --check` dans `typecheck` ([détail](#types-cloudflare)) | S0    | livré  | `wrangler`    |
| Secrets         | CF secrets + Vaultwarden                                                                                                                                                    | S0    | livré  |               |

#### Types Cloudflare

Runtime types = sortie de `wrangler types src/worker-configuration.d.ts --include-env=false` dans `apps/example-api` et `apps/mcp-example`, alignée sur `compatibility_date` + flags de leur `wrangler.toml`. Le fichier vit sous `src/` : le projet de l'app le possède comme le reste de ses sources (`tsconfig-orphans` n'attribue aux workspaces que `src/**`). `@cloudflare/workers-types` n'est plus la source des apps (son entrée par défaut vise une date de compat antérieure à 2021-11-03).

- **`--include-env=false`** : `--include-env` lit `.dev.vars` (mesuré : sortie différente avec / sans ce fichier) ; la CI n'en a pas. Runtime-only est déterministe ; l'`Env` reste écrit à la main (`apps/example-api/src/env.ts`, clés string = SSoT Zod `env.schema.ts`).
- `bun run types` (par app) régénère avec wrangler sous Node — **jamais** `bunx --bun wrangler types` : sous le runtime Bun, le `fetch` vers `http://dummy.com/` de la génération sort sur Internet et a écrit une page HTML parquée dans le fichier (mesuré avec wrangler 4.147.0). Le script `typecheck` de chaque app lance `wrangler types … --check` avant `tsc` : toute dérive (wrangler, compat date, flags) échoue. Un bump de `wrangler` embarque un autre `workerd` : la PR doit régénérer (`bun run types` dans les deux apps) et committer le diff.
- Hors apps : `packages/flows` garde `@cloudflare/workers-types` v5 (pas de `wrangler.toml`) ; le projet racine (`tsconfig.json`, outillage) inclut le `src/worker-configuration.d.ts` d'`example-api` (les scripts importent le code Worker).

Escape hatch : Postgres/Hyperdrive si un app dépasse D1 — documenté, pas default.

---

### B. Frontend (TanStack-centric)

| Couche                                                         | Choix                                                                                | Quand       | Statut         | Paquets                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------- | -------------- | ----------------------------------------------------------------------------------- |
| React **19** + **Vite**                                        | SPA sur Workers assets / Pages                                                       | M3          | livré          | `react`, `vite`                                                                     |
| **TanStack Router**                                            | routes + search params typés                                                         | M3          | livré          | `@tanstack/react-router`                                                            |
| **TanStack Query v5**                                          | tout état serveur (pas `useEffect` fetch)                                            | M3          | livré          | `@tanstack/react-query`                                                             |
| **TanStack Form** + Zod                                        | forms                                                                                | M3          | livré          | `@tanstack/react-form`                                                              |
| **TanStack Table**                                             | listes admin selon [ADR-0010](../architecture/adr/0010-list-page-cursor-envelope.md) | M3+         | livré          | `@tanstack/react-table`                                                             |
| **TanStack Hotkeys**                                           | raccourcis clavier ([UI kit](../ui-kit.md))                                          | M3+         | livré          | `@tanstack/react-hotkeys`                                                           |
| **TanStack Markdown**                                          | rendu markdown ([UI kit](../ui-kit.md))                                              | M3+         | livré          | `@tanstack/markdown`                                                                |
| **TanStack Virtual**                                           | listes virtualisées                                                                  | P1          | cible          | `@tanstack/react-virtual`                                                           |
| **TanStack Pacer**                                             | debounce search/upload                                                               | P1          | cible          | `@tanstack/react-pacer`                                                             |
| **TanStack Start**                                             | **optionnel** SSR/marketing only                                                     | non default | option produit | `@tanstack/react-start`                                                             |
| TanStack DB / Charts                                           | non default (beta / deprecated)                                                      | —           | option produit | `@tanstack/react-db`                                                                |
| **Tailwind v4** · **lucide** · **CVA** + clsx + tailwind-merge | style shadcn                                                                         | M3          | livré          | `tailwindcss`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge` |
| **sonner**                                                     | toasts (`@kit/ui`)                                                                   | M3          | livré          | `sonner`                                                                            |
| **Recharts**                                                   | charts (`chart.tsx` shadcn)                                                          | M3+         | livré          | `recharts`                                                                          |
| **react-day-picker** + **date-fns**                            | calendrier / dates (`@kit/ui`)                                                       | M3+         | livré          | `react-day-picker`, `date-fns`                                                      |

**CVA** = Class Variance Authority — variants type-safe des classes Tailwind (Button `variant`/`size`). Standard shadcn.

---

### C. UI — `packages/ui`

| Élément                     | Contenu                                                                          | Statut | Paquets          |
| --------------------------- | -------------------------------------------------------------------------------- | ------ | ---------------- |
| **shadcn/ui** sources owned | Base UI default 2026                                                             | livré  | `@base-ui/react` |
| Contenu kit                 | Button, Input, Field, Dialog, Sheet, Sidebar, Toast, Dropdown, Table shell, Form | livré  |                  |
| Thème                       | CSS vars · light/dark · tokens Kit                                               | livré  |                  |
| Assets (ShipFast extras)    | favicon, apple-icon, OG/twitter images, logo                                     | cible  |                  |

**Interdit** : composants métier produit.

---

### D. Auth + **cookies**

| Élément                       | Choix                                                                                                                                                | Quand | Statut | Paquets                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------------------------- |
| Sessions UI (**aujourd’hui**) | **Better Auth** cookies via `@kit/auth` SessionPort — [ADR-0002](../architecture/adr/0002-session-hmac-interim-vs-better-auth.md) (HMAC **retired**) | kit   | livré  | `better-auth`, `@kit/auth` |
| API keys machine              | `sk_…` hash en D1, **per-user**                                                                                                                      | kit   | livré  | `@kit/auth`                |
| Guards (kit)                  | Hono middleware dual-path `requireAuth` (Bearer **ou** cookie) dans `example-api`                                                                    | kit   | livré  |                            |

#### Cookies (obligatoire — sessions UI)

| Règle        | Détail                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Qui set      | Better Auth handler `ALL /api/auth/*` → `Set-Cookie`                                                   |
| Attributs    | **HttpOnly** · **Secure** (prod) · **SameSite=Lax** (ou `None`+Secure si cross-site strict) · `Path=/` |
| Domain       | parent `.example.com` si SPA/API sous-domaines ≠ ; sinon **même host** (préféré M3)                    |
| Client fetch | **`credentials: 'include'`** sur apiClient central                                                     |
| CORS         | si hosts séparés : `Allow-Credentials: true` + origin **explicite** (jamais `*`)                       |
| CSRF         | SameSite + vérif Origin sur mutations                                                                  |
| MCP / skill  | **pas de cookies** → Bearer `sk_…` only                                                                |
| Helpers      | `@kit/auth` cookie options env-aware · `hono/cookie` si besoin                                         |

**Non-default :** Clerk.

**[ADR-0002](../architecture/adr/0002-session-hmac-interim-vs-better-auth.md) (2026-07-30) :** session navigateur = **Better Auth only** (HMAC retiré). Dual-path restant = cookie session **\|** Bearer `sk_`. Pattern : **1 instance auth / request** (bindings) + `SessionPort`.

#### Auth matrix (kit dogfood)

| Mode                    | Surface                                                                                       | Credential                                       | Notes                                                                                                                                                                                                                                                                               | Statut |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Password**            | `POST /api/auth/sign-in/email` · `/login`                                                     | email + password → **cookie**                    | default login tab                                                                                                                                                                                                                                                                   | livré  |
| **Sign-up (opt-in)**    | `POST /api/auth/sign-up/email` · `/sign-up`                                                   | email + password + name → **cookie**             | SPA + BA only when `ALLOW_PUBLIC_SIGNUP=true` (`GET /health.allowPublicSignup` is UX); **default off** — forks opt in via product wrangler vars; CTA hidden + `/sign-up` → `/login` when off; failed sign-up 4xx → kit envelope (disabled 403, else generic 400, no existence leak) | livré  |
| **Magic link**          | `POST /api/auth/sign-in/magic-link` · verify `GET /api/auth/magic-link/verify` · `/login` tab | one-shot email link (TTL **5 min**) → **cookie** | EmailPort template; `disableSignUp` = `!ALLOW_PUBLIC_SIGNUP` (default **off**); no user enumeration; retained GET and accepted login-CSRF residual: [ADR-0002 D8](../architecture/adr/0002-session-hmac-interim-vs-better-auth.md#d8--verification-credentials-and-magic-link-get)  | livré  |
| **Forgot / reset**      | request-password-reset · reset-password                                                       | email link → set password                        | EmailPort; verification identifiers hashed; reset revokes sessions ([ADR-0002 D8](../architecture/adr/0002-session-hmac-interim-vs-better-auth.md#d8--verification-credentials-and-magic-link-get))                                                                                 | livré  |
| **API key**             | `Authorization: Bearer sk_…`                                                                  | **no cookie**                                    | MCP **stdio** / machine HTTP; mint after session                                                                                                                                                                                                                                    | livré  |
| **Remote agent**        | hosted Streamable HTTP `/mcp`                                                                 | **Worker MCP access token**                      | [ADR-0015](../architecture/adr/0015-mcp-remote-oauth-worker.md) — not cookies, not `sk_`, not Google AT                                                                                                                                                                             | livré  |
| OAuth GitHub (+ Google) | —                                                                                             | M3 (§ D, ligne OAuth GitHub) · Google = produit  | hors kit default                                                                                                                                                                                                                                                                    | cible  |

---

### E. MCP

| Élément         | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Statut         | Paquets                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------ |
| **Préféré**     | **[FastMCP](https://github.com/punkpeye/fastmcp)** (TS) — tools Zod; **EdgeFastMCP** Workers for hosted Streamable HTTP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | livré          | `fastmcp`                            |
| **Alternative** | SDK officiel [`@modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk) + thin wrapper                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | option produit |                                      |
| Package Kit     | `@kit/mcp` = conventions (logging, catalogue, stdio `sk_` whoami) autour de FastMCP — pas un 3ᵉ framework. La sous-entrée optionnelle `@kit/mcp/hosted` porte le shell OAuth; la racine ne charge ni `fastmcp` ni `@cloudflare/workers-oauth-provider`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | livré          | `@kit/mcp`                           |
| Hosted          | `createHostedMcpWorker` sert `/mcp` et le serveur d’autorisation MCP Worker (`OAUTH_KV`). `register(server, { identity })` est recréé à chaque `/mcp` authentifié et admis; `identityPort` ne mint jamais. `fallthrough` est réservé aux routes produit de confiance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | livré          | `@cloudflare/workers-oauth-provider` |
| Stdio           | CI smoke only (`bun run smoke:mcp` / **CP-MCP-SMOKE**). Does **not** prove HTTP or OAuth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | livré          |                                      |
| Auth remote     | Worker-issued MCP token (human `userId` + optional email). Identity port = caller. Dogfood = Better Auth ticket. FastMCP Google/GitHub **login** providers are **not** the MCP AS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | livré          |                                      |
| Skill           | thin HTTP client → API Hono                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | cible          |                                      |
| Example         | `mcp-example` : `ping` / `whoami` only; one app, two transports; consent exception is caller-supplied `demo-loopback`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | livré          |                                      |
| Produit         | App dédiée `apps/<product>-mcp` **optionnelle** : le shell peut aussi précéder le Worker produit par `fallthrough`. Le shell ne sert que `fetch` : `export default { ...productWorker, fetch: hosted.fetch }` garde les handlers `queue` et `scheduled` du produit. Les chemins OAuth réservés ne passent jamais au produit et Cloudflare Access les exclut. La co-localisation met la page de consentement sur l’origine produit : tout script qui y tourne (XSS, contenu utilisateur, script tiers) peut approuver le consentement ; une origine qui sert du contenu utilisateur ou un script tiers prend l’App dédiée. Déploiement : `OAUTH_KV`, `ENVIRONMENT=production` ou `staging`, `MCP_PUBLIC_URL` (origine https publique, MCP à `<origine>/mcp`) et `global_fetch_strictly_public` pour CIMD | option produit |                                      |

**Présentation du consentement hosted** — `HostedMcpWorkerOptions.consentPresentation?: ConsentPresentation`, exporté uniquement par `@kit/mcp/hosted`, fournit des données statiques : `locale` (`en` ou `fr`), `serviceName` et disclosures `{ label, text }` readonly. Omettre l'option conserve le comportement anglais existant ; omettre `locale` sélectionne `en`. La factory copie ces données une fois à sa construction, sans persistance OAuth. Les textes sont échappés, jamais interprétés comme HTML ou Markdown ; les labels protocole/sécurité restent Kit-owned, sans négociation de langue ni switcher.

Cette présentation ne porte aucune autorité : elle ne change ni identité, scopes, PKCE, CSRF, politique de consentement, TTL ou minting. Elle ne fournit ni renderer, callbacks, liens, CSS, attributs de formulaire ou overrides de labels de sécurité. Contrat exhaustif et garde des seams : [ADR-0015 D5/D8](../architecture/adr/0015-mcp-remote-oauth-worker.md#d5--consent-is-a-caller-policy-default-always-show).

**Admission OAuth hosted** — l'option facultative `grantAdmission` ajoute uniquement un refus aux requêtes MCP authentifiées et aux échanges de code ou de refresh token. Son omission conserve le comportement existant ; elle ne remplace ni l'authentification du fournisseur ni les contrôles métier. Contrat des refus, indisponibilités et de l'exception de promotion limitée : [ADR-0015 D2](../architecture/adr/0015-mcp-remote-oauth-worker.md#d2--worker-issued-token-only).

Autres étoiles (contexte, pas spine) : mcp-use (~10k), mcp-agent (~8k), openai-mcpkit (scaffold auth), FastMCP Python (autre runtime).

---

### F. Erreurs centralisées (FE + BE)

#### Backend — `@kit/core`

```text
AppError { code, status, message?, details?, cause? }
  → Hono onError middleware
    → log: requestId, code, stack/cause (interne)
    → JSON public: { error: { code, message }, requestId }
```

| Règle             |                                                                                 |
| ----------------- | ------------------------------------------------------------------------------- |
| Codes             | `SCREAMING_SNAKE` partagés (`SLUG_EXISTS`, `UNAUTHORIZED`, `VALIDATION_ERROR`…) |
| Client            | message générique / i18n-ready — **jamais** stack, SQL, paths                   |
| Zod               | → `VALIDATION_ERROR` + `fieldErrors?`                                           |
| `private_key` bad | **404** (frame, no existence leak)                                              |
| requestId         | header + body                                                                   |

#### Frontend

```text
HttpError { status, message }  ← any non-OK HTTP response
  └─ ApiError { code, requestId, details }  ← kit envelope
  → apiErrorToMessage / toast / field errors / ErrorBoundary
```

Les contrôles par statut utilisent `HttpError`, pas seulement `ApiError`; les champs
de l'enveloppe nécessitent un narrowing vers `ApiError`. Une erreur réseau n'est pas
une erreur HTTP. Les corps non-kit ne sont pas affichés : message sûr `HTTP <status>`.
Le callback `onUnauthorized(HttpError)` accepte une promesse; ses erreurs sont
ignorées pour préserver le rejet HTTP. Migration : [guide client](../../../packages/api-client/README.md#http-errors-and-migration).

| Surface        | Comportement                                               |
| -------------- | ---------------------------------------------------------- |
| TanStack Query | onError global + toast                                     |
| Forms          | map fieldErrors                                            |
| Boundary       | page d’erreur + CTA support (ShipFast-style mailto / chat) |
| 401            | clear session → login                                      |

**Shared :** `ErrorCode` + type `ApiErrorBody` dans `@kit/types` ou `core` — une SSoT FE/BE.  
Ref pattern : `kit-boilerplate` (`errorCodes`, `errorUtils`, `ApiError`).

---

### G. i18n (multilang)

| Élément           | Contenu                                                                                                                          | Statut | Paquets     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| Config            | App `createI18n({ defaultLocale, catalogs })` — **catalog keys = locales**                                                       | livré  |             |
| Switcher          | `@kit/ui` `LocaleSwitcher` — **hidden if `locales.length === 1`**                                                                | livré  |             |
| Kit dogfood       | `example-web` **FR+EN** (switch on)                                                                                              | livré  |             |
| Product 1 langue  | catalogs `{ fr }` only — no EN file, no switcher chrome                                                                          | livré  |             |
| Notifications API | Catalogues App FR+EN et Inbox rendu à la lecture via la valeur exacte d'`Accept-Language` (ADR-0019) ; repli FR                  | livré  |             |
| Tooling           | Catalogs TS app-owned + `@kit/i18n` engine (live) · **Paraglide monorepo park** (B8)                                             | livré  |             |
| Routing           | path `/fr` `/en` ou locale cookie (non implémenté ; SPA storage key `kit.locale`)                                                | cible  |             |
| Erreurs API       | **codes stables** ; copy traduite **côté UI** (pas 12 langues hardcodées backend)                                                | livré  |             |
| Emails            | templates par locale (P1)                                                                                                        | cible  |             |
| Package           | `@kit/i18n` **live** (pure engine + `hasLocaleSwitcher` / `resolveLocale`; opt-in React provider and hook via `@kit/i18n/react`) | livré  | `@kit/i18n` |

---

### H. Packages SaaS (carte)

| Package                  | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Prio              | Statut | Paquets              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | -------------------- |
| `@kit/core`              | `AppError` + `newRequestId` + `toApiErrorBody`, helpers curseur list-page, `createLogger`, `parseOrThrow`/`zodFieldErrors`; re-exporte `ErrorCode` de `@kit/types`. **Pas** de `Result`, **pas** de fabrique d'IDs, **pas** de schéma env — l'env Worker Zod est app-owned                                                                                                                                                                                                      | **P0**            | livré  | `@kit/core`          |
| `@kit/db`                | Handle D1 : `createDb` + types duck D1 + `D1_IN_ARRAY_CHUNK`/`mapInChunks` + `isUniqueConstraintError` / `toWorkerdD1Error`. Unique conflict = workerd `(extended: SQLITE_CONSTRAINT_UNIQUE\|PRIMARYKEY)` when present, else engine prefix `UNIQUE constraint failed:` at the start of a cause message (PK included). Never bound params, never `.code`. **Aucune** table ([ADR-0012](../architecture/adr/0012-kernel-persistence-request-context.md) D3), **pas** de `migrate` | **P0**            | livré  | `@kit/db`            |
| `@kit/storage`           | R2 put/get/presign                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **P0**            | livré  | `@kit/storage`       |
| `@kit/auth`              | SessionPort + `sk_` + org-role helpers; BA factory `@kit/auth/factory`; SPA password forms `@kit/auth/react` (forgot / reset / change — pages stay in the app) ([ADR-0002](../architecture/adr/0002-session-hmac-interim-vs-better-auth.md) · [ADR-0003](../architecture/adr/0003-multi-tenant-rbac-modules.md) · [ADR-0008](../architecture/adr/0008-kit-schema-identity-product-compose.md) D6)                                                                               | **P0**            | livré  | `@kit/auth`          |
| `@kit/types`             | Zod schemas + ErrorCode + shared audience/visibility helpers ([ADR-0007](../architecture/adr/0007-tasks-comments-kernel.md) D3)                                                                                                                                                                                                                                                                                                                                                 | **P0**            | livré  | `@kit/types`         |
| `@kit/api-client`        | Browser `createApiClient` + `HttpError` / `ApiError` + validation field-error helpers · `credentials: 'include'` default · i18n via app catalog in `apiErrorToMessage`                                                                                                                                                                                                                                                                                                          | **P0**            | livré  | `@kit/api-client`    |
| `@kit/ui`                | shadcn Base UI shell                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **P0**            | livré  | `@kit/ui`            |
| `@kit/email`             | Templates + transports `log` \| `smtp` \| **`cf`** (prod default) \| `resend` (escape) — [ADR-0004](../architecture/adr/0004-email-transport-cf-default.md)                                                                                                                                                                                                                                                                                                                     | **P0**            | livré  | `@kit/email`         |
| `@kit/i18n`              | Locale engine; catalogs app-owned; 1 catalog = no switcher                                                                                                                                                                                                                                                                                                                                                                                                                      | **P0**            | livré  | `@kit/i18n`          |
| `@kit/mcp`               | Conventions FastMCP/SDK (logging, `sk_`, registry, ping/whoami) et sous-entrée optionnelle `/hosted` pour le shell OAuth Worker — grant∩ non construit; catalogue jamais autorisation                                                                                                                                                                                                                                                                                           | **P0** example    | livré  | `@kit/mcp`           |
| `@kit/flows`             | Pure plan engine: YAML MVP · `check` · grant∩permits · snapshot helpers ([ADR-0005](../architecture/adr/0005-flows-platform-agentic-workflows.md) · Roxabi/roxabi-boilerplate-cf#16 · Roxabi/roxabi-boilerplate-cf#27–28); Workflows/D1/API = children Roxabi/roxabi-boilerplate-cf#29–31 · promote **D6 only**                                                                                                                                                                 | **P0** incubating | livré  | `@kit/flows`         |
| `@kit/tasks`             | Task engine: stages · visibility · links · opaque scope · AudiencePort helpers ([ADR-0007](../architecture/adr/0007-tasks-comments-kernel.md)) + tables Drizzle et repos derrière `@kit/tasks/schema` / `@kit/tasks/repos` ([ADR-0012](../architecture/adr/0012-kernel-persistence-request-context.md) D2/D3) ; dogfood D1 + routes livré dans `example-api` · **no resource links until resource system**                                                                      | **P0** incubating | livré  | `@kit/tasks`         |
| `@kit/comments`          | Multi-target comments (`target_type`+`target_id`, visibility) — compose with tasks + product entities ([ADR-0007](../architecture/adr/0007-tasks-comments-kernel.md)) ; table Drizzle + repos derrière `@kit/comments/schema` / `@kit/comments/repos` ([ADR-0012](../architecture/adr/0012-kernel-persistence-request-context.md) D2/D3)                                                                                                                                        | **P0** incubating | livré  | `@kit/comments`      |
| `@kit/notifications`     | Pure registry/rules/resolution/rendering root plus separate D1 schema and scoped repositories: atomic intentions, audited configuration, admission receipts, fair candidate pagination and retention ([ADR-0019](../architecture/adr/0019-notifications-rules-inbox-and-delivery.md), [ADR-0020](../architecture/adr/0020-notification-delivery-ownership.md)). E1/E2 only; no producer wiring or external Delivery runtime                                                     | **P1**            | livré  | `@kit/notifications` |
| _(no `@kit/agents` yet)_ | Agent loop / code-mode → **after** flows runner evidence · optional future agents ADR · product code-mode only                                                                                                                                                                                                                                                                                                                                                                  | blocked until D6  | cible  | `@kit/agents`        |
| Rate limit               | **Livré dans `@kit/auth`** (`packages/auth/src/repos/rate-limit.ts` ; throttle Better Auth deny-by-default `packages/auth/src/repos/ba-throttle.ts`) — pas de package `@kit/rate-limit` séparé ; D1/KV / CF binding                                                                                                                                                                                                                                                             | P1                | livré  | `@kit/auth`          |
| Audit                    | **Livré dans `@kit/auth`** (`packages/auth/src/repos/audit.ts`) — events append-only ; pas de package `@kit/audit` séparé                                                                                                                                                                                                                                                                                                                                                       | P1                | livré  | `@kit/auth`          |
| `@kit/jobs`              | Queues/cron helpers — cible future, **non retenue pour la V0 notifications** : le demo reste dans l’App, sans second call site artificiel ; contrat Delivery Workflow dans [ADR-0020](../architecture/adr/0020-notification-delivery-ownership.md)                                                                                                                                                                                                                              | P1                | cible  | `@kit/jobs`          |
| `@kit/observability`     | logs + hooks Sentry/OTel (Workers Logs natifs d'ici là, § I)                                                                                                                                                                                                                                                                                                                                                                                                                    | P1                | cible  | `@kit/observability` |
| `@kit/billing`           | Stripe stubs                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **P2**            | cible  | `@kit/billing`       |
| flags / webhooks         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P2                | cible  |                      |

**Sources des cellules vérifiées :** `@kit/core` = `packages/core/src/index.ts` (barrel) · env Worker Zod = `apps/example-api/src/env.schema.ts` · assets outillage = `packages/config/tsconfig.base.json` + `packages/config/vitest-coverage.mts`, consommés en relatif (ex. `apps/example-api/tsconfig.json`, `apps/example-api/vitest.config.ts`) · `@kit/db` = `packages/db/src/index.ts` · apply path des migrations = `migrations_dir` dans `apps/example-api/wrangler.toml` · schémas kit composés par l'app = `apps/example-api/src/db/schema.ts` · tables tasks/comments = `packages/tasks/src/drizzle-schema.ts`, `packages/comments/src/drizzle-schema.ts`.

**Règle package :** 2 call sites **ou** ADR — pas de squelettes vides massifs.

**`packages/config/` n'est pas un Package (décision Roxabi/roxabi-boilerplate-cf#245).** Le dossier ne porte **pas** de `package.json` : il n'existe aucun `@kit/config`, aucun runtime, aucun test, et il n'apparaît ni dans la carte ci-dessus ni dans le runner de coverage (`scripts/kit/test-coverage.sh`). Il héberge deux assets d'outillage consommés **par chemin relatif** : `tsconfig.base.json` (via les `extends` de la racine, des Apps et des Packages) et `vitest-coverage.mts` (via `makeCoverage` dans les configurations Vitest). Il reste sous `packages/` parce que [ADR-0009](../architecture/adr/0009-kit-namespace-polarity-inheritance-marker.md) D2 garde ce préfixe kit-owned — donc zero-edit — et parce que déplacer l'adresse casserait les `extends` et imports des repos Product au prochain sync, pour un gain cosmétique.

Ce paragraphe n'est pas la garde ; deux gates le sont. Remettre un `package.json` ici redonne un Package sans importeur dans `apps/` : `scripts/kit/extract-dry-run.sh` échoue en `ORPHAN package`. Et depuis la suppression du manifeste, `scripts/kit/check-tsconfig-orphans.ts` ne soustrait `<ws>/src/**` que pour un dossier **qui porte un manifeste** : un `.ts` ajouté sous un dossier d'assets est signalé `ORPHAN` au lieu d'être supposé couvert (cas `src under a manifest-less packages/ dir` dans `scripts/kit/test-tsconfig-orphans.sh`).

---

### H2. Email — transport par environnement ([ADR-0004](../architecture/adr/0004-email-transport-cf-default.md))

| Env         | Transport                                                                                                                                                                    | UI / inspection                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **local**   | Worker = `log` (console redacted). SMTP → **Mailpit** = Node `@kit/email/server` only — **jamais** Worker (`assertEmailTransportAllowed`)                                    | Console Worker · Mailpit `http://127.0.0.1:8025` (Node only) |
| **staging** | Worker = `cf` (preferred) **ou** `resend` ; allowlist + subject `[TEST STAGING]` + From `@example.com`. SMTP catcher = Node `@kit/email/server` only — **jamais** var Worker | Pas de spam client réel                                      |
| **prod**    | **`cf`** Cloudflare Email Sending binding (default) · `resend` escape hatch                                                                                                  | Logs CF / provider — **pas** de catcher                      |

**Décision kit** (`@kit/email`, shipped go-silex/silex-boilerplate#21) :

```text
EMAIL_TRANSPORT=log | smtp | cf | resend
# log  → development|test only (fail-closed elsewhere)
# cf   → Workers EMAIL binding (prod default)
# smtp → Mailpit — Node @kit/email/server only, never Worker (local or staging)
# resend → optional escape (RESEND_API_KEY)
```

- Templates kit : invite, reset-password, demo (copy FR-first).
- **Jamais** `EMAIL_TRANSPORT=log` en staging/prod.
- Compose local : service `mailpit` dans `docker-compose.yml` (SMTP 1025 · UI 8025) — **Node** `@kit/email/server` only, pas le path Worker / `wrangler`.

---

### I. Qualité, review, observabilité, analytics

#### DX / qualité code

| Outil                | Choix                                                                                                                                                                                                           | Quand | Statut | Paquets                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | --------------------------------- |
| Lint/format          | **Biome**                                                                                                                                                                                                       | S0    | livré  | `@biomejs/biome`                  |
| Tests                | **Vitest** + harness mémoire : `better-sqlite3` (D1 en mémoire) + vraies migrations (`apps/example-api/src/test/memory-env.ts`)                                                                                 | S0    | livré  | `vitest`, `better-sqlite3`        |
| Tests (pool Workers) | `@cloudflare/vitest-pool-workers` — **bloqué** : la dernière (0.22.0) exige le peer `vitest ^4.1.0`, le kit est sur vitest 5                                                                                    | S0    | cible  | `@cloudflare/vitest-pool-workers` |
| E2E                  | **Playwright** via `playwright-core` : script local-only `apps/example-web/scripts/e2e-design-system.mjs` (`bun run test:e2e:design-system`), hors CI et hors `validate:full` ([testing](../testing.md) CP-E2E) | P1    | livré  | `playwright-core`                 |
| Hooks                | **Lefthook** (pre-commit Biome · **pre-push = validate:full** primary gate) + commitlint · CI = garde-fou                                                                                                       | S0    | livré  | `lefthook`, `@commitlint/cli`     |
| CI                   | GH Actions `bun run validate:full` (SSoT: root `package.json` script — do not copy the step list here) + secret-scan — **bloquant**                                                                             | S0    | livré  |                                   |
| Security headers     | HSTS, X-Frame-Options, nosniff, Referrer-Policy (ShipFast) — `packages/auth/src/security-headers.ts`                                                                                                            | S0/M0 | livré  |                                   |
| Schema validation    | Zod partout (ShipFast security)                                                                                                                                                                                 | S0    | livré  | `zod`                             |

#### AI code review (PR)

| Option                                      | Rôle                                             | Reco Kit                                             |
| ------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| **CodeRabbit**                              | review PR AI, Conventional Comments, ok monorepo | **P1 default** si budget — déjà cité ShipFast/ixartz |
| **GitHub Copilot code review**              | natif GH                                         | alternatif si seats Copilot                          |
| **Cursor Bugbot / autres**                  | variable                                         | option                                               |
| **Agents indépendants de l’implémentation** | dev-core                                         | **toujours** sur changements sécu/auth               |

→ **CodeRabbit (ou équivalent)** sur PRs dès que CI stable ; ne remplace pas la preuve ciblée ni la revue par un agent indépendant de l’implémentation sur une zone sensible.

#### Logs / uptime / APM

| Option                                              | Force                                         | Faiblesse                 | Reco                                                                                                             | Statut         |
| --------------------------------------------------- | --------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| **CF Workers observability** + logs structurés JSON | natif, cheap                                  | moins « product »         | **P0** (toujours) — `[observability]` activé dans `example-api` et `mcp-example` ([détail](../observability.md)) | livré          |
| **Better Stack** (Logtail + Uptime + incidents)     | simple, bon DX indie/SaaS, prix prévisible    | moins profond que Datadog | recommandé en prod petite équipe — **choix produit**, pas livré par le kit                                       | option produit |
| **Datadog**                                         | APM complet, traces, metrics                  | cher, overkill agency     | **non default** sauf contrat client enterprise                                                                   | option produit |
| **GlitchTip** (self-host)                           | Sentry-like OSS, déjà écosystème ops possible | ops self-host             | alternatif errors si on refuse SaaS                                                                              | option produit |
| **Grafana Cloud**                                   | metrics/logs/traces                           | setup                     | option mid                                                                                                       | option produit |

→ **Default kit :** logs structurés + Workers Logs CF (livré). Better Stack (logs + uptime) = **option produit** quand prod ; Datadog = exception.

#### Errors vs product analytics vs telemetry (ne pas confondre)

| Besoin                                                         | Outil                     | Reco                                                                                                                                | Statut         | Paquets              |
| -------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------- |
| **Error tracking** (exceptions FE/BE)                          | **Sentry** (ou GlitchTip) | choix produit — source maps, release, Workers SDK si dispo ; câblé seulement si `SENTRY_DSN` ([observability](../observability.md)) | option produit | `@sentry/cloudflare` |
| **Product analytics** (funnels, events, feature flags product) | **PostHog**               | **P2** si on instrumente produit SaaS ; self-host possible                                                                          | option produit | `posthog-js`         |
| **Web analytics privacy** (pages vues, pas de cookies lourds)  | **Plausible**             | **Deferred-closed** — hub opt-in, pas de phone-home par défaut ; snippet env-gated seulement si une SPA publique entre au hub       | fermé          |                      |
| **OpenTelemetry**                                              | traces/metrics standard   | **P2** si multi-services + export Better Stack/Grafana ; pas jour 1                                                                 | cible          |                      |
| ShipFast DataFast                                              | analytics marketing Marc  | non — rester Plausible/PostHog                                                                                                      | fermé          |                      |

**Deferred choices (DR-B8):** Paraglide remains parked while TypeScript catalogs and `@kit/i18n` are live; reconsider only when at least two products encounter key drift or locale-path needs, or a hub mandates it. The L1 changelog recipe is allowed; an L2 patchlog package remains parked until at least two products need the same in-app CRUD and Markdown/static is insufficient. Plausible remains opt-in as above. TanStack Start is not the default backend: the kit spine is Vite SPA + Hono Worker; marketing/SSR-only use is an exception. Do not unpark these choices without their criteria and a new ADR or goal.

**Règle anti-doublon :**

```text
Plausible  = trafic web anonyme (sites)
Sentry     = crashs & exceptions
PostHog    = product events / feature flags produit (si besoin)
OTel       = standard de transport (optionnel)
Better Stack = logs agrégés + uptime + alertes
```

Ne pas activer PostHog **et** Plausible **et** Sentry Session Replay sans raison — privacy + coût.

#### ShipFast extras (indices gardés)

- Favicon / OG / logo conventions
- Error page + support CTA
- Rate limit auth + API
- Security headers
- Zod validation
- OAuth + magic links (via Better Auth)
- Stripe / email (P2/P1)
- **Pas** Next stack

---

### J. Hors stack default Chemin A

| Non                            | Pourquoi               |
| ------------------------------ | ---------------------- |
| Next / OpenNext spine          | Chemin B               |
| NestJS                         | Node, pas Workers      |
| Prisma primary                 | D1                     |
| Clerk                          | lock-in                |
| Shared team API key            | frame                  |
| TanStack Start as only backend | casse MCP multi-client |
| Datadog default                | coût / complexité      |
| Billing multi-tenant share v1  | frame non-goal         |

---

### K. Forme monorepo

```text
kit/
├── packages/   core config db storage auth types ui i18n email mcp …
├── apps/
│   ├── example-api/ example-web/ mcp-example/   # kit extractible
│   └── <product>-*                             # product repos only (not in this kit)
├── tooling/
├── .github/workflows/
├── package.json          # bun workspaces
├── turbo.jsonc
├── biome.json
└── AGENTS.md            # point d’entrée agent unique (Claude / Grok / Cursor)
```

| Zone               | Upgrade                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `packages/*`       | kit only (optional modules)                                                                  |
| `apps/example-*`   | prouve kit seul                                                                              |
| `apps/<product>-*` | product repos (inherit immediate parent as fetch-only `upstream`); never dual-edit kit paths |

### Couches API

| Layer    | Peut             | Ne peut pas                |
| -------- | ---------------- | -------------------------- |
| repos    | `@kit/db`        | services, routes           |
| services | repos, packages  | D1/R2 brut hors storage/db |
| routes   | services, guards | repos direct               |
| web      | ui, api client   | secrets serveur            |

Règles : guard first · Zod double frontière · pas de god file · packages ↛ apps · private_key → 404.

---
