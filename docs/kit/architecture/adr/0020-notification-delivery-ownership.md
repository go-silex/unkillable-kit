---
title: 'ADR-0020 — Un Workflow complet à identité stable par Delivery'
status: accepted
normative: true
date: 2026-10-22
amended: 2026-11-21
axial: false
related:
  - AGENTS.md
  - GLOSSARY.md
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0018-durable-execution-ownership.md
  - docs/kit/standards/stack.md
  - docs/kit/environments.md
  - 'Roxabi/roxabi-boilerplate-cf#455'
  - 'Roxabi/roxabi-boilerplate-cf#470'
  - 'Roxabi/roxabi-boilerplate-cf#471'
  - 'Roxabi/roxabi-boilerplate-cf#480'
summary: 'Stable-ID Workflow ownership for notification Delivery; Queue demo boundary'
supersedes_notes: >
  2026-11-21 : corps réduit aux décisions, justifications et limites ; les détails d’implémentation résident uniquement dans le code et les tests cités. Aucune décision modifiée.
---

# ADR-0020 — Un Workflow complet à identité stable par Delivery

Contrat accepté le 2026-10-22 : un Workflow par Delivery, admission automatique sous 24 h. User/email est implémenté ; Slack et Organization/email restent non composés.
Les [preuves](../../testing/ownership.md#notifications-email-delivery-owner) ne prouvent pas un déploiement. La configuration demo retries/DLQ de D2 reste une cible, absente du `wrangler.toml` actuel.

Mickael a [explicitement accepté le 2026-11-06](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/480#issuecomment-6685989031) l’amendement de D6 pour E5 : décodage strict des enveloppes natives observées et neutralisation du backoff implicite. Le minimum `retryAfterSeconds`, les cinq retries, les trois steps, le Durable owner unique et l’horizon d’admission de 24 h restent inchangés; les preuves et la revue indépendante restent requises.

## Contexte

La décision initiale de [Roxabi/roxabi-boilerplate-cf#455](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/455) retenait une outbox D1, une Queue de Deliveries et un Cron de remise des lignes sans `enqueued_at`. Or une Queue peut accepter un message avant un crash qui empêche l’écriture du marqueur. `enqueued_at IS NULL` ne prouve donc pas « jamais accepté ». Une republication peut remplacer un job déjà détenu par son durable owner et rouvrir son budget, ce qu’interdit [ADR-0018 D2](./0018-durable-execution-ownership.md#d2--owner-criterion).

L’ID d’une instance Workflows est choisi à l’admission. Cloudflare refuse de créer un second exemplaire de cet ID tant que le premier existe, y compris pendant sa rétention terminale. Cette protection n’est pas éternelle : après rétention, le même ID peut être réutilisé. Elle justifie une réconciliation bornée, pas une boucle de recréation permanente.

Le Kit compose déjà `WorkflowEntrypoint`, `step.do` et les reçus D1 dans ses plan runs. La Delivery n’est pas un plan run : elle reste une exécution distincte, avec ses propres params, guards et budget. Le cœur notifications reste pur et l’App possède ses bindings et entrypoints.

## Décision

### D1 — Le Workflow possède la Delivery entière

Une instance Cloudflare Workflows à ID stable possède chaque Delivery externe entière, User ou Organization destination. Les plan runs gardent leur owner ; le job demo reste sur Queue. Organization et Slack restent non composés.

Implémentation : `apps/example-api/src/notifications-delivery/workflow.ts`.

Le Workflow de Delivery réalise lui-même les guards, l’appel Channel, les retries et la persistance du résultat. **Il ne se contente pas de publier dans une Queue.** Il n’existe ni Queue de notifications, ni DLQ de notifications, ni consumer de finalisation, ni Queue de parking. Les propositions de rétention Queue à 14 jours et de parking d’une DLQ de finalisation deviennent sans objet.

L’outbox est l’intention de Delivery, écrite dans le même `D1Database.batch()` que la Notification quand celle-ci existe. Après commit, l’App demande l’admission du Workflow. Le Cron ne fait que demander cette admission bornée, constater l’état fourni par l’owner et purger selon les règles de rétention. Il ne choisit ni étape, ni effet à reprendre.

Cette ADR ne modifie pas ADR-0018 : elle applique D1–D4 à une nouvelle exécution Kit. Elle ne change pas le durable owner des plan runs et ne dispense pas un Product des décisions d’owner que D5 lui demande de documenter.

### D2 — Pas d’extraction `@kit/jobs` sans deuxième usage réel

Le déplacement de la Delivery vers Workflows laisse un seul consumer Queues réel : le demo. Le Kit ne conserve donc pas artificiellement l’extraction `@kit/jobs` envisagée dans [Roxabi/roxabi-boilerplate-cf#471](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/471). Aucun Package vide, helper générique, enveloppe générique ou type de disposition partagé n’est créé pour soutenir cet ancien découpage.

La configuration **cible, non construite** du demo prévoit des retries bornés et une DLQ dans ses deux consumers : `max_retries = 5`, `retry_delay = 60`, batch 10 et timeout 5 inchangés ; DLQ `example-api-demo-dlq` en local simulé et `boilerplate-api-demo-dlq` en showcase. Le `wrangler.toml` actuel ne configure ni ces retries ni ces DLQ. Le changement reste soumis à revue indépendante, sans staging ni transformation de l’Example App en point de départ à copier.

Code et configuration actuels : `apps/example-api/src/jobs/demo-handler.ts` et `apps/example-api/wrangler.toml`.

Le demo conserve son contrat HTTP, son format propre et ses comportements utiles; aucune migration vers une enveloppe `@kit/jobs` n’est nécessaire. Les inconnus permanents peuvent être acquittés avec log de rejet; les tentatives réellement interrompues demandent le retry natif. `ack()` et `retry()` sont les opérations CF; aucune API native `fail()` ou « dead-letter immédiat » n’est inventée. Le budget épuisé déclenche le transfert natif vers la DLQ, sans forwarding automatique de celle-ci vers sa source.

### D3 — Référence minimale, stricte et server-owned

Le cœur `@kit/notifications` expose la référence et son schéma; l’App construit les params depuis une Delivery persistée, jamais depuis une commande client de démarrage de Workflow.

La référence ne porte que l’Organization, le kind et l’ID : ni contenu, adresse, token, grants ou état de reprise fourni par le client. Toute opération est org-scopée ; aucun privilège ambiant du producteur n’est transmis. L’ID de Delivery ne sert jamais à une nouvelle intention.

L’identité déterministe est calculée et vérifiée par `apps/example-api/src/services/notifications/delivery-identity.ts` et `apps/example-api/src/notifications-delivery/workflow.ts`.

Le tuple JSON évite l’ambiguïté d’une concaténation de segments. Le préfixe versionne cet encodage sans versionner la Delivery. L’ID compte 70 caractères du charset CF, sous sa limite de 100; la résistance aux collisions est celle de SHA-256, pas une preuve d’injectivité mathématique. L’App utilise Web Crypto existant, sans dépendance supplémentaire.

Le mapping `workflowId ↔ (orgId, kind, id)` est persisté immuablement avec l’intention et protégé par unicité dans chaque table; les deux kinds séparent les espaces d’identité. Le Workflow vérifie le mapping avant usage. Une collision détectée est un incident fail-closed : aucun salt, nouveau préfixe, ID aléatoire de secours ou écrasement n’ouvre une seconde exécution. Les Deployments utilisent des ressources Workflows distinctes; aucune promesse ne traverse leur frontière.

### D4 — Admission et réconciliation limitées à 24 h

L’admission reste distincte du statut de Delivery. La deadline est fixée à la création par l’horloge serveur, jamais repoussée. Un statut `pending` ne prouve pas l’absence d’owner ; aucun marqueur ou compteur D1 ne devient une deuxième autorité de retry.

Implémentation : `apps/example-api/src/notifications-delivery/admission.ts` et `packages/notifications/src/repos/admission.ts`.

#### Preconditions de sécurité de l’identité

1. L’admission automatique exige `now < admissionDeadlineAt`; à égalité, elle est fermée. La création d’intention et le contrôle utilisent le temps serveur, pas un timestamp client.
2. La rétention effective de succès **et** d’erreur doit rester supérieure à l’horizon avec une marge : **minimum trois jours pour un horizon d’un jour**, soit deux jours de marge. Conserver les defaults natifs : Free trois jours; Paid sept jours pour les nouvelles définitions, trente jours pour les anciennes qui les conservent ([limites CF](https://developers.cloudflare.com/workflows/reference/limits/)). Aucun `default_retention` ou override d’instance ne les raccourcit sous ce minimum.
3. Aucun caller automatique ne fait `delete`, `deleteBatch`, `restart`, changement d’ID ou changement de ressource pour contourner une collision d’admission. Un opérateur ne supprime pas une instance encore utilisée comme preuve d’admission dans cette fenêtre.
4. La rétention terminale commence à la fin native, pas à la création D1. Même si une instance finit immédiatement après son admission, son identité reste retenue au-delà de la totalité de la fenêtre d’admission.
5. Le futur contrôle de configuration et sa revue doivent prouver ces préconditions avant livraison. Aucun changement Cloudflare ni contrôle n’est effectué par cette ADR; si la rétention observée devient incompatible, suspendre les créations automatiques concernées plutôt que recréer sans garantie.

#### Protocole d’admission

La réconciliation observe ou demande l’admission avec le même ID dans la fenêtre. Une réponse perdue, un `get` en erreur ou une exception « exists » ne prouvent ni absence ni présence ; seule une preuve positive confirme l’admission. À la deadline sans preuve, l’admission devient `expired`, mais la Delivery reste `pending`, sans échec provider inventé.

Implémentation : `apps/example-api/src/notifications-delivery/admission.ts` et `apps/example-api/src/notifications-delivery/admission-helpers.ts`.

Un crash après `create` mais avant le marqueur est donc réconcilié par l’identité native retenue, pas par la supposition qu’une marque absente prouve un premier envoi. Deux demandeurs concurrents utilisent le même ID; un seul crée l’instance. Le premier step de cette instance peut aussi enregistrer sa propre admission prouvée. Une preuve positive tardive peut faire `expired → admitted`, sans création, restart ou nouvelle deadline.

#### Cron et états observables

Le Cron observe l’owner et peut projeter conditionnellement un résultat terminal valide, sans appeler le Channel ni écraser un reçu terminal. Une fin native en erreur ne prouve pas que l’effet externe n’a pas eu lieu ; un état inconnu ou un output invalide ne devient pas un succès inventé. La maintenance est bornée et org-scopée, sans autorité de navigateur ni boucle de drainage illimitée.

Implémentation : `apps/example-api/src/notifications-delivery/maintenance.ts` et `apps/example-api/src/notifications-delivery/admission-helpers.ts`.

**Au-delà de 24 h, aucune création ni relance automatique**, même si `get` échoue et même si l’ID est stable. Les recherches de preuve de cette réconciliation automatique sont bornées à cette fenêtre; les lignes non prouvées passent à `expired`, sans sondage perpétuel. Un Workflow déjà admis continue normalement ses steps et peut écrire ses reçus après la deadline : l’horizon ferme l’admission, pas son exécution.

Après la rétention native, une instance introuvable peut être une instance ancienne supprimée : elle ne redevient jamais une preuve de « jamais démarré ». Diagnostic humain et consultation ponctuelle d’un owner encore retenu restent possibles, mais aucune procédure automatique ne repart de D1. Aucun redrive utilisateur n’est livré en V0; une décision individuelle ultérieure doit respecter ADR-0018 D2.

### D5 — Trois steps natifs, aucun journal de reprise App

L’owner sépare admission, send et finalisation en trois steps natifs, sans écriture nécessaire détachée dans `waitUntil()`. Le send a cinq retries maximum ; la finalisation a son propre budget et ne rejoue pas un send checkpointé. Un reçu terminal existant n’est jamais écrasé. Aucun contenu, adresse ou réponse provider brute n’est persisté dans un output ou une erreur de retry.

Implémentation : `apps/example-api/src/notifications-delivery/workflow.ts`.

Avant l’appel externe, les guards relisent membership, accès Module effectif, règles courantes et non-résolution de la Notification; pour une Organization destination, ils relisent sa configuration et son opt-in de type. Ils ne rouvrent pas l’ACL de l’objet source : sa visibilité a été établie à l’émission et son snapshot suit le contrat notifications. Un refus connu renvoie `skipped`; une panne de lookup n’est pas transformée en refus. L’Inbox reste la Notification, sans Delivery `in_app`.

La préparation du destinataire a lieu **dans le callback de chaque tentative de `delivery:send`**, y compris un retry natif : recharger l’App User, son email et son état de vérification, puis résoudre l’identité et l’installation courantes. Aucune adresse User, génération ou permission préparée dans un ancien step de préflight ne remplace cette hydratation live. Pour un DM Slack, l’adaptateur revalide l’identité par `users.info` à chaque tentative et applique son lookup de récupération borné avant le POST; son cache email de cinq minutes n’est pas une dispense de cette revalidation. Le Workflow ne checkpointe que le résultat du send, jamais une adresse prévalidée à réutiliser après un réveil.

`recordAttempt` et `lastAttemptAt` sont des diagnostics écrits dans le step. Ils ne choisissent jamais la prochaine étape, le nombre de retries restants ou le prochain réveil. Ils ne promettent pas un comptage exactly-once des appels physiques autour d’un crash. Le seul compteur autoritaire est le contexte natif de retry du step.

Si `delivery:send` épuise son budget, le `run()` attrape une fois l’exception sortie de `step.do` et produit `{status:'failed',code:'delivery_retries_exhausted'}` pour `delivery:finish`. Ce catch n’est pas une boucle de retry et n’appelle pas le provider. Une panne de `delivery:finish` utilise son propre step natif sans rejouer un `delivery:send` déjà checkpointé.

Après trois retries épuisés de finalisation, l’instance peut finir `errored` avec D1 non terminal. La réconciliation ne répare cette projection que si elle constate une preuve native dans sa fenêtre; sinon l’incident reste visible. Aucun fallback qui ré-exécute le Channel ni aucune promesse de persistance terminale inconditionnelle sous panne D1 permanente.

### D6 — Classification et délai dynamique natifs

Un résultat `sent` signifie accepté par le transport, pas reçu ou lu. Un résultat permanent échoue sans retry ; une interruption inconnue est retryable, sans deviner sa permanence depuis le nom ou le message d’une erreur. Un hint supérieur à 86 400 secondes termine avec `retry_after_exceeds_budget` au lieu de l’écrêter et d’envoyer trop tôt ; ce n’est pas une reclassification de permanence provider.

Implémentation : `apps/example-api/src/notifications-delivery/retry-attempt.ts` et `apps/example-api/src/notifications-delivery/workflow.ts`.
L’adaptateur Slack parse `Retry-After` en entier sûr non négatif; une valeur invalide est omise et zéro est normalisé à une seconde. L’adaptateur ne tronque pas une valeur valide à 24 h, n’effectue ni sleep ni retry et conserve le résultat `retryable`; le Workflow applique le budget local.

La classification précède le throw. Le protocole privé non secret accepte strictement les deux enveloppes natives observées ; une enveloppe malformée ou non reconnue arrête le retry au lieu de perdre un hint et d’envoyer trop tôt. Une interruption native sans namespace privé n’apporte aucun hint. La preuve ciblée doit démontrer le décodage réel, le délai planifié et le respect du minimum, pas seulement le résultat d’une fonction appelée directement.

Sans hint, le délai est de 60, 120, 240 secondes, puis double ; avec hint, il vaut le maximum de cette base et du hint arrondi à la seconde supérieure, plafonné au plafond local de 86 400 secondes.
Le backoff natif constant évite un second multiplicateur implicite. Pas de sleep, boucle de nouveaux steps, tableau D1 de tentatives ou remplacement d’instance pour reproduire le runtime.

Implémentation : `apps/example-api/src/notifications-delivery/retry.ts` et `apps/example-api/src/notifications-delivery/workflow.ts`.

Le timeout est également une interruption, pas la preuve qu’un provider n’a rien accepté. L’horizon d’admission de 24 h n’est pas une deadline de réception : cinq délais de retry peuvent dépasser cinq jours avec le temps de traitement ou de file. L’owner conserve ses steps tant que l’exécution est active; la rétention terminale ne commence qu’ensuite.

### D7 — Garanties, transitions et limites

- Après commit sans preuve d’admission, la récupération utilise le même ID pendant 24 h ; ensuite l’incertitude reste visible. Pas de garantie at-least-once globale sans condition d’admission.
- L’identité stable empêche un second Workflow pendant la fenêtre sûre, mais ne déduplique pas l’effet provider. Si le provider accepte avant le checkpoint du send, un retry peut produire un doublon : aucun exactly-once sans idempotence provider.
- Une fois le send checkpointé, une panne D1 peut réessayer la finalisation sans nouvel appel provider ; cela réduit seulement la fenêtre précédente. Un reçu terminal existant n’est pas écrasé.

Un changement de permission entre le dernier guard et l’appel externe peut aussi courir avec cet appel : aucun verrou distribué n’est promis. Les logs structurés portent Organization, type, Channel et code non secret, sans adresse email, body, contenu sensible ou token. Aucune alerte active via le moteur en panne n’est ajoutée.

La purge reste celle du contrat notifications : Notification à 90 jours depuis `createdAt`, avec cascade de ses Deliveries User, même si leur admission reste `unknown` ou `expired`; Delivery terminale à 30 jours depuis `finishedAt`. Une Organization Delivery sans parent Notification, encore non terminale, expire à 90 jours depuis `createdAt`. Les durées de rétention restent des variables du Deployment, distinctes de l’horizon d’admission figé à un jour.

`admissionStatus=expired` ne constitue pas un échec provider ni une Delivery terminale à purger à 30 jours. La suppression à 90 jours ne fabrique pas non plus un tel échec. Un owner tardif qui ne retrouve plus sa ligne s’arrête sans envoyer ni la recréer; une suppression concurrente après la dernière lookup ne peut annuler un effet déjà en vol. La maintenance ne supprime pas l’instance Workflows pour faire passer la purge et ne réutilise jamais l’ID d’une Delivery purgée.

### D8 — Preuve de conformité à ADR-0018 D2

La seule instance Workflows persiste et reprend steps, résultats, retries et réveils ; D1 porte intentions, guards, reçus et projections, pas un programme de reprise. Cron observe ou demande l’admission bornée. Aucune Queue ne conduit une partie de la Delivery ; aucun restart, nouvel ID ou renouvellement de deadline ne remplace l’owner. Après send, la finalisation reste dans le même owner ; une projection terminale ne rejoue aucun effet.

Implémentation : `apps/example-api/src/notifications-delivery/workflow.ts` et `apps/example-api/src/notifications-delivery/admission.ts`.

La preuve reste soumise à la revue d’un agent indépendant exigée par `AGENTS.md`. Cette ADR n’affirme pas qu’un gate mécanique vérifie D2, l’isolement Organization, l’unicité physique d’un effet ou la politique d’un Product.

## Contrat repository `@kit/notifications/repos` — E2 → E5

Le repository applique les observations atomiquement et sous scope Organization ; il ne fabrique jamais de preuve native ni ne contacte le runtime. Une preuve positive tardive peut confirmer une admission expirée sans créer d’instance. Les observations ambiguës ne dégradent pas une admission prouvée et ne modifient pas le résultat terminal ; l’absence dans l’Organization ne justifie ni lookup globale ni recréation.

La sélection des candidats est bornée et équitable, sans promesse de snapshot global. Avant chaque admission native, l’App contrôle de nouveau l’heure serveur : une continuation de pagination ne prolonge pas les 24 h. Le curseur n’est ni une autorité, ni une progression d’exécution ou lease.

Implémentation et tests : `packages/notifications/src/repos/admission.ts`, `packages/notifications/src/repos/admission-cursor.ts` et `packages/notifications/src/repos/admission-reconciliation.test.ts`.

## Contrat d’interface App

La composition App fournit stockage, horloge serveur, binding et ports ; le cœur notifications ne crée pas ses dépendances. Le binding et l’entrypoint Workflow appartiennent à l’App ; `FLOW_RUN` reste inchangé. Aucun nouveau seam `@kit/jobs` n’est requis.

Le runbook doit documenter déploiement, rétention native, diagnostic et coût des steps/retries. La compatibilité de l’horizon avec Free ne signifie pas que la charge tient dans le budget CPU Free de 10 ms ; le showcase est Workers Paid.

Implémentation : `apps/example-api/src/notifications-delivery/admission.ts` et `apps/example-api/wrangler.toml`.

## Alternatives écartées et conséquences

- Queue + Cron republiant les marques absentes : absence non probante, remplacement possible d’un owner et budget neuf.
- Workflow wrapper publiant un job Queue : ownership partagé et finalisation répartie entre deux chemins.
- Admission one-shot sans récupération native : containment réduisant la garantie ; la fenêtre bornée conserve la récupération tout en laissant l’incertitude hors fenêtre.
- `@kit/jobs` pour le seul demo : contrat générique et dette sans deuxième usage actuel.
- Boucle D1 de retries, IDs renouvelés ou restart automatique : durabilité artisanale et remplacement interdits par D2.

L’owner unique permet une admission réconciliable dans la fenêtre sûre et une finalisation distincte du send. Il coûte une définition Workflows, des steps et retries, des métadonnées d’admission et une preuve de rétention ; ce n’est pas une Queue gratuite. Une panne d’admission peut dépasser 24 h, une panne D1 le budget de finalisation et un provider peut accepter avant perte du checkpoint.

## Preuves attendues à l’implémentation

Les preuves et leurs limites sont documentées dans [testing](../../testing/ownership.md#notifications-email-delivery-owner). Elles ne remplacent pas la revue indépendante de l’ownership, de l’isolation et du déploiement, ni la preuve des préconditions externes. La configuration demo retries/DLQ reste à réaliser.

## Sources relues et limites de preuve

Les choix reposent sur [ADR-0001](./0001-primary-axis-packages-compose-apps.md), [ADR-0018](./0018-durable-execution-ownership.md), le [glossaire](../../../../GLOSSARY.md) et les [limites Cloudflare](https://developers.cloudflare.com/workflows/reference/limits/). Les preuves existantes ne prouvent ni déploiement, ni rétention effective du compte, ni réception provider.
