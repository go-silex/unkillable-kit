---
title: 'ADR-0020 — Un Workflow complet à identité stable par Delivery'
status: accepted
normative: true
date: 2026-10-22
amended: 2026-11-14
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
---

# ADR-0020 — Un Workflow complet à identité stable par Delivery

Contrat accepté le 2026-10-22 : un Workflow complet par Delivery et une fenêtre d’admission automatique de 24 h depuis la création de l’intention. Le dépôt contient `NotificationDeliveryWorkflow`, l'admission et la réconciliation pour User/email ; Slack et Organization/email restent non composés. Les preuves et leurs limites figurent dans [testing](../../testing.md#notifications-email-delivery-owner) et ne prouvent pas une exécution déployée. La configuration demo retries/DLQ décrite en D2 est également une cible : elle n'est pas configurée dans le `wrangler.toml` actuel.

Mickael a [explicitement accepté le 2026-11-06](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/480#issuecomment-6685989031) l’amendement de D6 pour E5 : décodage strict des enveloppes natives observées et neutralisation du backoff implicite. Le minimum `retryAfterSeconds`, les cinq retries, les trois steps, le Durable owner unique et l’horizon d’admission de 24 h restent inchangés; les preuves et la revue indépendante restent requises.

Amendment 2026-11-14: absent-code specifications linked below are non-normative design notes; the decisions remain binding.

## Contexte

La décision initiale de [Roxabi/roxabi-boilerplate-cf#455](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/455) retenait une outbox D1, une Queue de Deliveries et un Cron de remise des lignes sans `enqueued_at`. Or une Queue peut accepter un message avant un crash qui empêche l’écriture du marqueur. `enqueued_at IS NULL` ne prouve donc pas « jamais accepté ». Une republication peut remplacer un job déjà détenu par son durable owner et rouvrir son budget, ce qu’interdit [ADR-0018 D2](./0018-durable-execution-ownership.md#d2--owner-criterion).

L’ID d’une instance Workflows est choisi à l’admission. Cloudflare refuse de créer un second exemplaire de cet ID tant que le premier existe, y compris pendant sa rétention terminale. Cette protection n’est pas éternelle : après rétention, le même ID peut être réutilisé. Elle justifie une réconciliation bornée, pas une boucle de recréation permanente.

Le Kit compose déjà `WorkflowEntrypoint`, `step.do` et les reçus D1 dans ses plan runs. La Delivery n’est pas un plan run : elle reste une exécution distincte, avec ses propres params, guards et budget. Le cœur notifications reste pur et l’App possède ses bindings et entrypoints.

## Décision

### D1 — Le Workflow possède la Delivery entière

| Exécution                                              | Durable owner                                                                       | Composition App                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Une Delivery externe, User ou Organization destination | **Une instance Cloudflare Workflows à ID stable**, de l’admission à la finalisation | `NotificationDeliveryWorkflow`, ports Channel et stockage org-scopé |
| Un plan run gouverné                                   | Cloudflare Workflows, inchangé                                                      | `FlowRunWorkflow`, sans wrapper de Delivery                         |
| Un job message du demo existant                        | Cloudflare Queues, retries et DLQ explicites                                        | Consumer demo App, sans nouveau Package                             |

Le Workflow de Delivery réalise lui-même les guards, l’appel Channel, les retries et la persistance du résultat. **Il ne se contente pas de publier dans une Queue.** Il n’existe ni Queue de notifications, ni DLQ de notifications, ni consumer de finalisation, ni Queue de parking. Les propositions de rétention Queue à 14 jours et de parking d’une DLQ de finalisation deviennent sans objet.

L’outbox est l’intention de Delivery, écrite dans le même `D1Database.batch()` que la Notification quand celle-ci existe. Après commit, l’App demande l’admission du Workflow. Le Cron ne fait que demander cette admission bornée, constater l’état fourni par l’owner et purger selon les règles de rétention. Il ne choisit ni étape, ni effet à reprendre.

Cette ADR ne modifie pas ADR-0018 : elle applique D1–D4 à une nouvelle exécution Kit. Elle ne change pas le durable owner des plan runs et ne dispense pas un Product des décisions d’owner que D5 lui demande de documenter.

### D2 — Pas d’extraction `@kit/jobs` sans deuxième usage réel

Le déplacement de la Delivery vers Workflows laisse un seul consumer Queues réel : le demo. Le Kit ne conserve donc pas artificiellement l’extraction `@kit/jobs` envisagée dans [Roxabi/roxabi-boilerplate-cf#471](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/471). Aucun Package vide, helper générique, enveloppe générique ou type de disposition partagé n’est créé pour soutenir cet ancien découpage.

J1 devient l’alignement du demo : retries bornés et DLQ explicitement configurés dans ses deux consumers existants, docblock/runbook cohérents, boucle App par message. Configuration : `max_retries = 5`, `retry_delay = 60`, batch 10 et timeout 5 inchangés; DLQ `example-api-demo-dlq` en local simulé et `boilerplate-api-demo-dlq` en showcase. Ce changement de déploiement reste soumis à la revue indépendante. Il ne crée pas d’environnement staging et ne transforme pas l’Example App en point de départ à copier.

Le demo conserve son contrat HTTP, son format propre et ses comportements utiles; aucune migration vers une enveloppe `@kit/jobs` n’est nécessaire. Les inconnus permanents peuvent être acquittés avec log de rejet; les tentatives réellement interrompues demandent le retry natif. `ack()` et `retry()` sont les opérations CF; aucune API native `fail()` ou « dead-letter immédiat » n’est inventée. Le budget épuisé déclenche le transfert natif vers la DLQ, sans forwarding automatique de celle-ci vers sa source.

### D3 — Référence minimale, stricte et server-owned

Le cœur `@kit/notifications` expose la référence et son schéma; l’App construit les params depuis une Delivery persistée, jamais depuis une commande client de démarrage de Workflow.

```ts
import { z } from 'zod'

export const deliveryRefSchema = z.object({
  orgId: z.string().min(1).max(256),
  kind: z.enum(['user', 'organization']),
  id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/),
}).strict()

export type DeliveryRef = z.infer<typeof deliveryRefSchema>
```

| Champ / règle | Contrat                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orgId`       | Organization propriétaire. Toute lecture, tentative et transition porte ce scope. Aucun privilège ambiant du producteur n’est transmis.                                                                                  |
| `kind`        | Discriminant fixe de la table de Delivery : User ou Organization destination. Ce n’est pas un stage d’exécution.                                                                                                         |
| `id`          | Identifiant de la Delivery, jamais réutilisé pour une nouvelle intention. Le Workflow recharge Notification, destinataire et Channel depuis cette ligne org-scopée.                                                      |
| Params        | Exactement cette référence : pas de contenu, adresse, token, User IDs redondants, grants, compteur, délai, stage ou clé d’autorité fournie par le client. Les génériques TypeScript ne remplacent pas la validation Zod. |
| Entrée        | Le Workflow revalide les params et vérifie son ID avant tout effet ou lookup non bornée. Une référence invalide ou un ID incohérent termine par `NonRetryableError`, sans envoi ni lookup globale de récupération.       |

L’identité est déterministe :

```text
workflowId = "nd-v1-" + hexLowercase(
  SHA-256(UTF-8(JSON.stringify([
    "notification-delivery", 1, orgId, kind, id
  ])))
)
```

Le tuple JSON évite l’ambiguïté d’une concaténation de segments. Le préfixe versionne cet encodage sans versionner la Delivery. L’ID compte 70 caractères du charset CF, sous sa limite de 100; la résistance aux collisions est celle de SHA-256, pas une preuve d’injectivité mathématique. L’App utilise Web Crypto existant, sans dépendance supplémentaire.

Le mapping `workflowId ↔ (orgId, kind, id)` est persisté immuablement avec l’intention et protégé par unicité dans chaque table; les deux kinds séparent les espaces d’identité. Le Workflow vérifie le mapping avant usage. Une collision détectée est un incident fail-closed : aucun salt, nouveau préfixe, ID aléatoire de secours ou écrasement n’ouvre une seconde exécution. Les Deployments utilisent des ressources Workflows distinctes; aucune promesse ne traverse leur frontière.

### D4 — Admission et réconciliation limitées à 24 h

Les deux tables de Delivery portent les mêmes métadonnées d’admission. Les timestamps sont des entiers millisecondes UTC, issus du serveur.

| Champ                                                                | Sens                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `workflowId: string`                                                 | ID stable calculé avant le batch de création, jamais remplacé.                                     |
| `admissionStatus: 'pending' \| 'admitted' \| 'unknown' \| 'expired'` | Admission distincte de `Delivery.status`. `pending` n’est pas une preuve d’absence d’owner.        |
| `admissionDeadlineAt: number`                                        | Fixé atomiquement à `createdAt + 86_400_000`; jamais repoussé lors d’un nouvel essai.              |
| `admittedAt: number \| null`                                         | Date de première preuve positive observée; pas une estimation de l’heure d’envoi provider.         |
| `lastAdmissionCheckAt: number \| null`                               | Observation pour diagnostic et pagination équitable, pas checkpoint de progression de la Delivery. |

Colonnes SQL correspondantes : `workflow_id`, `admission_status`, `admission_deadline_at`, `admitted_at`, `last_admission_check_at`. `Delivery.status` reste `pending | sent | failed | skipped`. `attemptCount`, `lastAttemptAt`, `errorCode` et `finishedAt` suivent le contrat notifications. Aucun `enqueuedAt`, stage, lease de reprise ou compteur d’essais d’admission ne devient une deuxième autorité de retry.

#### Preconditions de sécurité de l’identité

1. L’admission automatique exige `now < admissionDeadlineAt`; à égalité, elle est fermée. La création d’intention et le contrôle utilisent le temps serveur, pas un timestamp client.
2. La rétention effective de succès **et** d’erreur doit rester supérieure à l’horizon avec une marge : **minimum trois jours pour un horizon d’un jour**, soit deux jours de marge. Conserver les defaults natifs : Free trois jours; Paid sept jours pour les nouvelles définitions, trente jours pour les anciennes qui les conservent ([limites CF](https://developers.cloudflare.com/workflows/reference/limits/)). Aucun `default_retention` ou override d’instance ne les raccourcit sous ce minimum.
3. Aucun caller automatique ne fait `delete`, `deleteBatch`, `restart`, changement d’ID ou changement de ressource pour contourner une collision d’admission. Un opérateur ne supprime pas une instance encore utilisée comme preuve d’admission dans cette fenêtre.
4. La rétention terminale commence à la fin native, pas à la création D1. Même si une instance finit immédiatement après son admission, son identité reste retenue au-delà de la totalité de la fenêtre d’admission.
5. Le futur contrôle de configuration et sa revue doivent prouver ces préconditions avant livraison. Aucun changement Cloudflare ni contrôle n’est effectué par cette ADR; si la rétention observée devient incompatible, suspendre les créations automatiques concernées plutôt que recréer sans garantie.

#### Protocole d’admission

```text
D1 batch : Notification éventuelle + Delivery + identité + deadline
  → après commit : demande d’admission
  → Workflows.create({ id: workflowId, params: ref })
  → preuve positive : admissionStatus=admitted
```

| Observation                                               | Action bornée                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivery terminale, ou admission déjà prouvée             | Pas de `create`. La fin native ou son reçu suffit; aucun reset du budget.                                                                                                                                                                                                                  |
| Référence admissible avant deadline, sans preuve positive | Tenter un `get(workflowId)`; une instance présente est une preuve positive, quel que soit son statut. Si sa présence n’est pas établie, `create` reste possible avec **le même ID**, sous les préconditions de rétention. Un `get` qui échoue n’est pas décrit comme une preuve d’absence. |
| `create` résout                                           | Persister `admitted`, `admittedAt` si absent et la date d’observation. L’écriture peut être répétée conditionnellement sans refaire le Workflow.                                                                                                                                           |
| `create` échoue, notamment parce que l’ID existe          | Consulter cette même instance. Seul un `get`/statut positif confirme l’admission; un texte d’exception « exists » deviné n’est pas une preuve suffisante. Ne jamais appeler `restart`.                                                                                                     |
| Réseau, timeout ou persistance ambigus                    | Conserver ou écrire `unknown`; si ce marquage échoue, la ligne peut rester `pending`. Ni l’un ni l’autre ne signifie « jamais créé ». Réessayer l’observation/admission avec le même ID seulement tant que la fenêtre reste ouverte.                                                       |
| Deadline atteinte sans preuve positive                    | CAS `admissionStatus=expired` depuis `pending`/`unknown`; **conserver `Delivery.status=pending`** et rendre l’incertitude visible. Aucun échec provider n’est fabriqué, même si la ligne était encore `pending`.                                                                           |

Un crash après `create` mais avant le marqueur est donc réconcilié par l’identité native retenue, pas par la supposition qu’une marque absente prouve un premier envoi. Deux demandeurs concurrents utilisent le même ID; un seul crée l’instance. Le premier step de cette instance peut aussi enregistrer sa propre admission prouvée. Une preuve positive tardive peut faire `expired → admitted`, sans création, restart ou nouvelle deadline.

#### Cron et états observables

Le Cron `*/5 * * * *` traite les intentions âgées d’au moins deux minutes, encore dans la fenêtre d’admission, et les passages de deadline non encore matérialisés. L’App conserve `scheduled()` et son dispatch par expression Cron; elle ne crée pas un nouveau Workflow récurrent qui génère des IDs différents.

Une passe traite au plus 100 références par Organization; ordre équitable sur dernière observation puis création/ID, sans boucle de drainage illimitée. L’Organization et `now` sont fournis par du code serveur. Le cadrage cross-Organization du job de maintenance reste explicite : chaque appel aux repos est org-scopé, jamais porté par une autorité de navigateur.

| État natif constaté pendant cette réconciliation            | Conséquence                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`, `running`, `waiting`, `paused`, `waitingForPause` | L’owner existe : marquer son admission si nécessaire; ne pas l’éveiller ni le recréer. Une pause n’autorise pas un second owner.                                                                                                                   |
| `complete`                                                  | Le résultat terminal validé peut être projeté conditionnellement dans D1 s’il manque. La projection n’exécute aucun Channel et n’écrase pas un reçu terminal existant. Un output absent/invalide reste un incident visible, pas un succès inventé. |
| `errored` ou `terminated`                                   | Preuve d’une fin native, pas d’un refus provider : une projection `failed` porte `delivery_workflow_errored` ou `delivery_workflow_terminated`. L’effet externe peut avoir eu lieu; aucun redrive automatique.                                     |
| `unknown`, appel en erreur ou instance introuvable          | Conserver l’incertitude. Aucun état terminal provider déduit de cette absence d’observation.                                                                                                                                                       |

**Au-delà de 24 h, aucune création ni relance automatique**, même si `get` échoue et même si l’ID est stable. Les recherches de preuve de cette réconciliation automatique sont bornées à cette fenêtre; les lignes non prouvées passent à `expired`, sans sondage perpétuel. Un Workflow déjà admis continue normalement ses steps et peut écrire ses reçus après la deadline : l’horizon ferme l’admission, pas son exécution.

Après la rétention native, une instance introuvable peut être une instance ancienne supprimée : elle ne redevient jamais une preuve de « jamais démarré ». Diagnostic humain et consultation ponctuelle d’un owner encore retenu restent possibles, mais aucune procédure automatique ne repart de D1. Aucun redrive utilisateur n’est livré en V0; une décision individuelle ultérieure doit respecter ADR-0018 D2.

### D5 — Trois steps natifs, aucun journal de reprise App

L’App exporte `NotificationDeliveryWorkflow extends WorkflowEntrypoint<Env, DeliveryRef>`. Les steps ont des noms fixes et tous les effets sont dans `step.do`; aucune écriture requise pour la correction n’est détachée dans `waitUntil()`.

| Step              | Travail complet et résultat                                                                                                                                                                                                                                             | Retry natif                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `delivery:admit`  | Charger la bonne table par `orgId + id`, vérifier `kind/workflowId`, enregistrer l’admission positive de cette instance. Une ligne manquante n’est jamais recréée.                                                                                                      | Trois retries, délai initial 10 s exponentiel, timeout par tentative 1 min.                          |
| `delivery:send`   | À **chaque tentative**, relire le reçu terminal et les faits d’autorité, préparer/rendre et appeler un Channel au plus une fois. Renvoyer un petit résultat terminal sérialisable, ou lever une erreur retryable normalisée après une tentative incapable de continuer. | **Cinq retries maximum** : six tentatives au plus; délai dynamique §D6; timeout par tentative 1 min. |
| `delivery:finish` | Depuis le résultat que Workflows a persisté, CAS de la ligne non terminale vers `sent`, `failed` ou `skipped`; poser code/date de fin et produire le log requis. Un reçu terminal existant n’est jamais écrasé.                                                         | Trois retries, délai initial 10 s exponentiel, timeout par tentative 1 min.                          |

Le résultat de `delivery:send` est `{status:'sent'|'failed'|'skipped', code:string|null}`. Une Delivery déjà terminale renvoie son état réel sans Channel. Le code appartient au protocole interne non secret; aucune adresse, contenu rendu ou réponse provider brute n’est persistée dans un output de step ou dans l’erreur de retry. Le résultat final de l’instance reflète le reçu terminal effectivement constaté par `delivery:finish`.

Avant l’appel externe, les guards relisent membership, accès Module effectif, règles courantes et non-résolution de la Notification; pour une Organization destination, ils relisent sa configuration et son opt-in de type. Ils ne rouvrent pas l’ACL de l’objet source : sa visibilité a été établie à l’émission et son snapshot suit le contrat notifications. Un refus connu renvoie `skipped`; une panne de lookup n’est pas transformée en refus. L’Inbox reste la Notification, sans Delivery `in_app`.

La préparation du destinataire a lieu **dans le callback de chaque tentative de `delivery:send`**, y compris un retry natif : recharger l’App User, son email et son état de vérification, puis résoudre l’identité et l’installation courantes. Aucune adresse User, génération ou permission préparée dans un ancien step de préflight ne remplace cette hydratation live. Pour un DM Slack, l’adaptateur revalide l’identité par `users.info` à chaque tentative et applique son lookup de récupération borné avant le POST; son cache email de cinq minutes n’est pas une dispense de cette revalidation. Le Workflow ne checkpointe que le résultat du send, jamais une adresse prévalidée à réutiliser après un réveil.

`recordAttempt` et `lastAttemptAt` sont des diagnostics écrits dans le step. Ils ne choisissent jamais la prochaine étape, le nombre de retries restants ou le prochain réveil. Ils ne promettent pas un comptage exactly-once des appels physiques autour d’un crash. Le seul compteur autoritaire est le contexte natif de retry du step.

Si `delivery:send` épuise son budget, le `run()` attrape une fois l’exception sortie de `step.do` et produit `{status:'failed',code:'delivery_retries_exhausted'}` pour `delivery:finish`. Ce catch n’est pas une boucle de retry et n’appelle pas le provider. Une panne de `delivery:finish` utilise son propre step natif sans rejouer un `delivery:send` déjà checkpointé.

Après trois retries épuisés de finalisation, l’instance peut finir `errored` avec D1 non terminal. La réconciliation ne répare cette projection que si elle constate une preuve native dans sa fenêtre; sinon l’incident reste visible. Aucun fallback qui ré-exécute le Channel ni aucune promesse de persistance terminale inconditionnelle sous panne D1 permanente.

### D6 — Classification et délai dynamique natifs

Le seam Channel reste celui des ADR notifications et Slack :

```ts
type ChannelResult =
  | { status: 'sent' }
  | { status: 'retryable'; code: string; retryAfterSeconds?: number }
  | { status: 'permanent'; code: string }
```

| Résultat / exception                                          | Décision du step `delivery:send`                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent`                                                        | Retourner le résultat `sent`; l’owner le checkpointe avant la persistance terminale D1. Cela signifie accepté par le transport, pas reçu/lu par le destinataire.                                                                   |
| `permanent`                                                   | Retourner `failed` avec le code connu. Aucun retry de l’effet ni throw destiné à forcer un budget natif.                                                                                                                           |
| `retryable`, hint absent ou ≤86 400 s                         | Lever l’erreur privée retryable normalisée; le runtime réessaie ce même step.                                                                                                                                                      |
| `retryable`, hint >86 400 s                                   | Retourner `failed`, code **`retry_after_exceeds_budget`**. Le budget local ne permet pas d’honorer ce minimum : ce n’est **pas** une reclassification de permanence provider. Ne pas clamper le hint puis envoyer trop tôt.        |
| Erreur inconnue de DB, rendu, transport ou runtime capturable | La tentative n’a pas pu continuer; erreur retryable normalisée avec code `delivery_attempt_interrupted`, sans hint inventé. Ne pas deviner la permanence depuis `Error.name`, un message de provider ou une erreur HTTP générique. |

Slack adapter parsing: [non-normative design note](../design-notes/0020-delivery.md#retry-after).

La classification précède le throw. L’erreur interne utilise seulement les champs standards persistables : `name='NotificationDeliveryRetryable'`, `message=JSON.stringify({code, retryAfterSeconds?})`. Le schéma JSON privé est strict, non secret, avec code non vide et hint fini non négatif ≤86 400.

Le callback accepte exactement deux encodages de ce même protocole : les champs privés conservés tels quels, ou l’enveloppe RPC observée `name='Error'` et `message='NotificationDeliveryRetryable: ' + JSON`. Il retire uniquement ce préfixe exact, une seule fois, puis revalide intégralement le JSON. Il ne recherche pas un hint dans un message provider, n’utilise ni `instanceof` ni propriété custom et n’accepte pas une succession arbitraire d’enveloppes.

Une enveloppe ou charge privée malformée/non reconnue est une non-conformité qui arrête le retry, jamais une permission de perdre le hint puis d’envoyer plus tôt. Une interruption native sans namespace privé n’apporte aucun hint. La preuve ciblée doit démontrer le décodage réel, le délai planifié par l’owner et le respect du minimum, pas seulement le résultat d’une fonction appelée directement.

La configuration CF de `delivery:send` utilise `retries.limit=5`, **`retries.delay=WorkflowDelayFunction`** et **`retries.backoff='constant'`**. Cette dernière valeur neutralise le backoff exponentiel implicite du runtime : seule la fonction ci-dessous choisit le délai, sans second multiplicateur. Elle reçoit `{ctx,error}`; `ctx.attempt` est indexé à 1 et appartient au runtime.

```text
baseSeconds = min(86400, 60 × 2 ^ min(11, max(0, ctx.attempt - 1)))
hintSeconds = ceil(retryAfterSeconds validé), ou 0 si absent
retryDelayMs = 1000 × min(86400, max(baseSeconds, hintSeconds))
```

La fonction rend un entier en **millisecondes** : 60 000, 120 000, 240 000… sans hint, jamais plus de 86 400 000. Le clamp final ne s’applique qu’à un hint déjà prouvé ≤86 400; la branche de dépassement a terminé avant le throw. Le runtime persiste l’échec, son retry et son réveil. Aucun `setTimeout`, sleep entre messages, tableau de tentatives en D1, boucle de six steps neufs ou remplacement d’instance ne reproduit ce travail.

Le timeout est également une interruption, pas la preuve qu’un provider n’a rien accepté. L’horizon d’admission de 24 h n’est pas une deadline de réception : cinq délais de retry peuvent dépasser cinq jours avec le temps de traitement ou de file. L’owner conserve ses steps tant que l’exécution est active; la rétention terminale ne commence qu’ensuite.

### D7 — Garanties, transitions et limites

| Situation                                                                    | État / garantie honnête                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit D1, puis interruption avant toute preuve d’admission                  | Notification et intention existent atomiquement. Admission récupérable avec le même ID pendant 24 h; après, `expired` et incertitude visible, pas de promesse at-least-once globale sans condition d’admission. |
| Doublon de demande d’admission dans la fenêtre sûre                          | Un seul Workflow retenu pour la référence; pas de budget neuf. L’ID ne déduplique pas l’effet provider.                                                                                                         |
| Provider accepte, puis résultat `delivery:send` perdu avant checkpoint natif | Le runtime peut refaire l’appel : doublon externe possible. Ni l’ID stable, ni D1, ni Workflows ne promet exactly-once sans idempotence provider.                                                               |
| Résultat `delivery:send` checkpointé, puis panne d’écriture D1               | Retry de `delivery:finish` sans nouvel appel provider. La séparation des steps réduit une fenêtre; elle ne supprime pas la précédente.                                                                          |
| Reçu terminal présent                                                        | La tentative native renvoie ce reçu sans nouvel envoi; `finish` est conditionnel et n’écrase pas cet état.                                                                                                      |

Un changement de permission entre le dernier guard et l’appel externe peut aussi courir avec cet appel : aucun verrou distribué n’est promis. Les logs structurés portent Organization, type, Channel et code non secret, sans adresse email, body, contenu sensible ou token. Aucune alerte active via le moteur en panne n’est ajoutée.

La purge reste celle du contrat notifications : Notification à 90 jours depuis `createdAt`, avec cascade de ses Deliveries User, même si leur admission reste `unknown` ou `expired`; Delivery terminale à 30 jours depuis `finishedAt`. Une Organization Delivery sans parent Notification, encore non terminale, expire à 90 jours depuis `createdAt`. Les durées de rétention restent des variables du Deployment, distinctes de l’horizon d’admission figé à un jour.

`admissionStatus=expired` ne constitue pas un échec provider ni une Delivery terminale à purger à 30 jours. La suppression à 90 jours ne fabrique pas non plus un tel échec. Un owner tardif qui ne retrouve plus sa ligne s’arrête sans envoyer ni la recréer; une suppression concurrente après la dernière lookup ne peut annuler un effet déjà en vol. La maintenance ne supprime pas l’instance Workflows pour faire passer la purge et ne réutilise jamais l’ID d’une Delivery purgée.

### D8 — Preuve de conformité à ADR-0018 D2

| Critère                                       | Application                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un seul owner persiste et reprend l’exécution | Les steps, résultats, retries et réveils sont ceux de la seule instance Workflows. D1 porte intentions, guards, reçus et projections; pas un programme de reprise.                    |
| Admission et guards autorisés                 | Cron appelle uniquement l’interface d’admission à ID stable sous horizon/rétention, ou observe l’owner. Un marqueur D1 absent n’est pas assimilé à un owner absent.                   |
| Pas de continuation Queue                     | Aucune Queue ne conduit un morceau de la Delivery; aucun stage sélectionné par `attempts`. Le contexte natif sert uniquement au délai de la tentative interrompue.                    |
| Pas de replacement/restart                    | Aucun nouvel ID, renouvellement de deadline, suppression/recréation tardive, DLQ cycle ou `Workflow.restart()` automatique. Une absence après rétention ne rouvre jamais l’admission. |
| Steps distincts après succès                  | Le succès du send conduit au step de finalisation **dans le même owner**, qui a checkpointé le résultat. La projection d’un terminal natif ne rejoue aucun effet.                     |

La preuve reste soumise à la revue d’un agent indépendant exigée par `AGENTS.md`. Cette ADR n’affirme pas qu’un gate mécanique vérifie D2, l’isolement Organization, l’unicité physique d’un effet ou la politique d’un Product.

## Contrat repository `@kit/notifications/repos` — E2 → E5

Cette section est l’unique norme de la surface de persistance d’admission. E2 livre ces exports et leurs preuves de transitions/pagination; E5 les compose depuis ses adapters App, sans SQL d’admission parallèle. Le contrat général `DeliveryRow`, `loadDelivery` et `finishDelivery` reste celui d’ADR-0019. `Db` réutilise le type opaque Drizzle D1 déjà employé par les repos du Kit; il n’est pas un nouvel export à inventer dans `@kit/db`.

```ts
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { ListPage } from '@kit/types'
import type { DeliveryRef } from '@kit/notifications'

type Db = DrizzleD1Database<Record<string, unknown>>
// DeliveryRow est le type du même sous-export repos, défini par ADR-0019.
export type DeliveryAdmissionReceipt = Readonly<Pick<DeliveryRow,
  | 'ref' | 'workflowId' | 'admissionStatus' | 'admissionDeadlineAt'
  | 'admittedAt' | 'lastAdmissionCheckAt' | 'status' | 'createdAt' | 'finishedAt'
>>

export type DeliveryAdmissionCandidate = DeliveryAdmissionReceipt & Readonly<{
  status: 'pending'
  action: 'observe' | 'expire'
}>

export type DeliveryAdmissionCandidatesQuery = Readonly<{
  now: number
  limit: number
  cursor?: string
}>

export type DeliveryAdmissionObservation =
  | Readonly<{ kind: 'admitted'; proof: 'created' | 'instance_present' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'expired' }>

export type RecordDeliveryAdmissionObservationInput = Readonly<{
  ref: DeliveryRef
  workflowId: string
  observedAt: number
  observation: DeliveryAdmissionObservation
}>

export type DeliveryAdmissionWriteResult =
  | Readonly<{ kind: 'updated' | 'unchanged'; receipt: DeliveryAdmissionReceipt }>
  | Readonly<{ kind: 'not_found' | 'identity_mismatch' }>

export declare function listDeliveryAdmissionCandidates(
  db: Db,
  scope: Readonly<{ orgId: string }>,
  query: DeliveryAdmissionCandidatesQuery,
): Promise<ListPage<DeliveryAdmissionCandidate>>

export declare function recordDeliveryAdmissionObservation(
  db: Db,
  input: RecordDeliveryAdmissionObservationInput,
): Promise<DeliveryAdmissionWriteResult>
```

### Observation et CAS monotones

Les entrées sont validées avant SQL : référence et `workflowId` selon D3, timestamps entiers sûrs non négatifs, `limit` entier 1..100, schéma discriminé exact sans champ supplémentaire. `proof` décrit la preuve native réellement obtenue par l’App (`create` réussi ou instance existante constatée), jamais une assertion client ou un `get` en erreur. Le repository ne contacte aucun runtime pour la fabriquer.

Chaque mutation choisit la table par `ref.kind` et borne **dans le prédicat SQL** `org_id=ref.orgId`, `id=ref.id`, `workflow_id=input.workflowId`. La condition de transition est appliquée atomiquement au dernier état, pas depuis un read antérieur devenu périmé. Écriture et lecture du reçu de retour forment une même opération transactionnelle D1; une projection retournée peut ensuite évoluer par concurrence, mais aucun résultat ne prétend avoir écrasé un état plus récent.

| Observation                     | Transition atomique permise                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admitted` avec preuve positive | `pending`, `unknown` ou `expired` → `admitted`, même si `observedAt >= admissionDeadlineAt`. Si déjà admitted, conserver cet état. Poser `admittedAt=observedAt` seulement s’il était nul; une date déjà persistée reste inchangée. Ne déplacer ni l’identité ni la deadline. Une preuve tardive ne crée rien. |
| `unknown`, avant deadline       | `pending`/`unknown` → `unknown`. Si une preuve admitted a gagné entre-temps, **conserver admitted et admittedAt**. Si l’état est expired, conserver expired.                                                                                                                                                   |
| `unknown`, à/après deadline     | `pending`/`unknown` → `expired`, sans changer `Delivery.status`; un résultat réseau tardif ne rouvre jamais la fenêtre. admitted et expired ne sont pas dégradés.                                                                                                                                              |
| `expired`, à/après deadline     | `pending`/`unknown` → `expired` seulement. Une preuve admitted concurrente gagne définitivement; un état expired déjà présent est conservé. Avant deadline, cette demande ne change aucun champ et retourne unchanged.                                                                                         |
| Toute observation applicable    | `lastAdmissionCheckAt=max(valeur persistée, observedAt)`, avec null comme absence de date. Une réponse ancienne ne fait jamais reculer cette observation. Aucun champ de tentative, contenu, identité, deadline ou résultat terminal n’est remplacé.                                                           |

Une ligne absente **dans l’Organization demandée** retourne `not_found`, sans lookup globale ni recréation. Si cette ligne existe mais porte un autre `workflowId`, retourner `identity_mismatch` sans mutation ni reçu de l’autre identité. `updated` signifie qu’au moins un champ d’admission/observation a effectivement changé; sinon retourner `unchanged` avec le reçu courant. Aucun de ces retours n’autorise un nouveau Workflow après deadline.

`status`, `errorCode` et **`finishedAt` sont hors patch d’admission**, même sur une réponse tardive. La projection terminale native utilise uniquement le `finishDelivery` d’ADR-0019 : CAS `pending → sent|failed|skipped`, code et `finishedAt=now` persistés ensemble. S’il est déjà terminal, conserver son état, son code et sa première date de fin; aucun replay ne prolonge la rétention terminale. Une admission expired n’appelle jamais ce terminal CAS à elle seule.

### Candidats, tri et curseur fermé sous les bornes

La liste fait un `UNION ALL` des deux tables de Delivery, **chacune déjà filtrée par `scope.orgId` et `status='pending'` avant tri et limite**. Une référence d’une autre Organization ne peut apparaître même via un curseur forgé. Le curseur est un seek opaque, pas une autorité; il ne transporte pas l’Organization, qui reste un paramètre obligatoire de chaque requête.

Le temps de sélection `asOf` est `query.now`, fixé pour la page et ses continuations. Les seuls candidats sont :

| Action    | Prédicats supplémentaires                                                          |
| --------- | ---------------------------------------------------------------------------------- |
| `observe` | `created_at <= asOf - 120_000`, `admission_deadline_at > asOf`, admission `pending | unknown                                                                        | admitted`. admitted signifie observation de l’owner seulement, jamais nouveau create. |
| `expire`  | `admission_deadline_at <= asOf`, admission `pending                                | unknown`. Une admission déjà expired n’est plus sondée; admitted n’expire pas. |

Appliquer également `last_admission_check_at IS NULL OR last_admission_check_at < asOf`. Trier en ordre ascendant par `(coalesce(last_admission_check_at,-1), created_at, id COLLATE BINARY)`. Les IDs ASCII préfixés `u_`/`o_` définis par ADR-0019 rendent cet ordre total entre les deux tables. Une continuation utilise le **strict après** lexicographique du même tuple; `kind` doit être cohérent avec le préfixe de l’ID. Aucun offset, ordre implicite ou page par table concaténée après limitation.

Le keyset exact, encodé par les helpers Worker JSON UTF-8/base64url de `@kit/core`, est :

```ts
type DeliveryAdmissionKeyset = Readonly<{
  asOf: number
  lastCheckAt: number
  createdAt: number
  kind: 'user' | 'organization'
  id: string
}>
```

Le repository refuse le curseur non base64url, vide ou de plus de 512 caractères, décodé non record, avec clé inconnue ou type/borne invalide; il valide les champs **avant** de construire le keyset SQL. Dates : entiers 0..9_007_199_254_740_991; seul `lastCheckAt` admet aussi la sentinelle **-1 pour null en stockage**. Le curseur ne contient jamais null : les helpers communs acceptent seulement des valeurs string/number. ID : longueur 1..256 et regexp `/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/`, puis contrôle du préfixe correspondant à `kind`. Sur continuation, `query.now` doit égaler `cursor.asOf`; une incohérence est une validation générique, sans détail du contenu décodé.

**Fermeture encode → requête :** avec ces alphabets, aucun échappement JSON ni expansion UTF-8 d’une valeur n’est nécessaire. Au maximum : 2 accolades + 45 caractères pour clés/guillemets/deux-points + 4 virgules + trois dates de 16 chiffres + `"organization"` (14 caractères) + ID entre guillemets (258) = **371 octets**. Base64url est donc ≤496 caractères, sous 512, y compris le cas maximal. La sentinelle -1 raccourcit encore ce keyset.

Le `limit+1` s’applique au résultat unifié **après** tous ces prédicats. Retourner au plus `limit` items; `nextCursor` provient du dernier item réellement rendu s’il existe un item supplémentaire, sinon null. Il conserve les valeurs de tri lues pour cet item, même si son observation change ensuite. Une observation effectuée pendant la passe, à une date serveur ≥asOf, retire ce candidat de cette passe via le prédicat sur dernière observation. Il ne remonte pas indéfiniment en tête.

Le prochain tick peut repartir sans curseur en tête avec un nouveau temps serveur : les moins récemment observés sont servis d’abord. Le curseur n’est jamais persisté comme progression d’exécution ou lease. Une passe ne traite qu’une page; les écritures concurrentes peuvent retirer ou déplacer un candidat, sans promesse de snapshot global. Le tick suivant le reconsidère s’il reste éligible. Avant chaque appel natif d’admission, l’App relit le reçu et contrôle **à nouveau l’heure serveur courante**, pas le `asOf` d’une ancienne page : aucune continuation de pagination ne prolonge les 24 h.

## Contrat d’interface App

En plus de `DeliveryRef`, les seams App minimaux sont les suivants; ce ne sont pas de nouveaux exports `@kit/jobs` :

```ts
function deliveryWorkflowId(ref: DeliveryRef): Promise<string>

function ensureDeliveryAdmission(ref: DeliveryRef): Promise<void>

function reconcileDeliveryAdmissions(input: {
  orgId: string
  now: number
  limit: number
}): Promise<void>
```

| Interface                     | Obligations cachées derrière ce seam                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliveryWorkflowId`          | Validation de la référence et encodage exact de D3; aucune génération aléatoire ni appel réseau.                                                                                                                                                                                                                                                |
| `ensureDeliveryAdmission`     | Recharge la ligne org-scopée, terminal-first, contrôle deadline et rétention, utilise exclusivement l’ID persisté et les opérations natives `get/create/status`. Persiste les observations; une erreur réseau reste unknown, pas succès d’effet. Une panne qui empêche même la persistance de l’observation peut lever sans réarmer l’identité. |
| `reconcileDeliveryAdmissions` | Entrées serveur, `limit` entier 1..100, une page équitable dans l’Organization, protocole D4. Ne boucle pas sur le stockage jusqu’à épuisement, n’appelle aucun Channel et ne reset aucun owner.                                                                                                                                                |

La closure App fournit stockage, horloge serveur, binding et ports; le cœur notifications ne crée pas ses dépendances. L’entrypoint et le binding `NOTIFICATION_DELIVERY: Workflow<DeliveryRef>` appartiennent à l’App. Noms : `example-api-notification-delivery` pour le local simulé, `boilerplate-api-notification-delivery` pour le showcase; classe `NotificationDeliveryWorkflow`, exportée par le Worker. `FLOW_RUN` reste inchangé.

Les blocs Workflows non héritables sont répétés dans les deux configurations existantes, sans staging inventé. Le runbook documentera le déploiement de cette nouvelle définition, sa rétention native, son diagnostic et le coût des steps/retries; aucune commande de création Queue/DLQ de notifications n’est conservée. Le showcase est déjà Workers Paid; compatibilité de l’horizon avec Free ne signifie pas que la charge de ses steps tient dans le budget CPU Free de 10 ms.

## Alternatives écartées et conséquences

| Alternative                                                 | Motif                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue + Cron qui republie les `enqueued_at=NULL`            | Absence de marque non probante; remplacement possible d’un owner et nouvelle allocation de retries.                                                     |
| Workflow wrapper qui publie un job Queue                    | Ne résout pas l’ownership complet demandé; réintroduit le split et la finalisation d’effet entre deux chemins.                                          |
| Admission one-shot puis unknown sans récupération native    | Containment qui réduit la garantie; Q6 retient plutôt l’identité native stable avec fenêtre de récupération, tout en conservant l’unknown hors fenêtre. |
| Garder `@kit/jobs` pour le seul demo                        | Extraction sans deuxième usage actuel; dette et contrat générique maintenus pour un découpage abandonné.                                                |
| Boucle D1 de retries, IDs renouvelés ou restart automatique | Hand-built durability/replacement au sens D2, même derrière un Package ou une supervision générale.                                                     |

| Conséquence | Portée                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Positive    | Un owner fourni possède l’effet et ses steps; admission réconciliable sans doubler l’instance pendant la fenêtre sûre; finalisation séparée du send checkpointé.                                                                                             |
| Coût        | Nouvelle définition Workflows, consommation native par Delivery/step/retry, metadata d’admission et preuve de rétention; revue indépendante du changement de déploiement. Ce n’est pas une Queue gratuite sous un autre nom.                                 |
| Limite      | Une panne d’admission peut durer au-delà de 24 h; une panne D1 peut survivre au budget de finalisation; un provider peut accepter avant perte du checkpoint. Ces cas ne sont pas masqués par une garantie exactement-once ou une fausse permanence provider. |
| Dépendances | Aucune bibliothèque nouvelle : Zod et Web Crypto existants, types runtime CF déjà générés par App. Pas de SDK Workflows supplémentaire, de lib de backoff ou de Package jobs.                                                                                |
| Livraison   | E0 fixe ce contrat; J1 aligne le demo sans Package; E5 livre Workflow, admission/réconciliation et purge. Les tickets, index, glossaire et autres ADR sont alignés séparément; aucun code applicatif n’est livré par cette ADR.                              |

## Preuves attendues à l’implémentation

1. Référence stricte et identité : tuple déterministe, deux kinds/Organizations distincts, longueur/charset, mismatch refusé, aucun fallback d’ID, toute opération SQL org-scopée.
2. Admission : concurrence, crash après `create` avant marque, réponse perdue, instance existante `errored/complete`, deadline avant/à/après 24 h, rétention raccourcie et absence après rétention. Aucun recreate tardif; unknown/expired ne deviennent pas un faux échec provider.
3. Retry natif : cinq retries de la même étape; hint dynamique respecté et transmis en millisecondes, erreur standard sérialisée préservée, plafond 24 h, dépassement `retry_after_exceeds_budget`, permanente sans retry; aucune branche de stage fondée sur les compteurs D1.
4. Effets et finalisation : guards live, reçu terminal sans provider, résultat checkpointé puis échec D1 sans nouvel envoi; panne finale conservée comme incident; purge à 90 jours et owner tardif sans recréation; fenêtre provider-before-checkpoint documentée.
5. Composition : plus de Queue/DLQ de notifications ni `@kit/jobs`, demo avec retries/DLQ, nouveaux bindings et rétention conformes; revue indépendante d’ownership/isolation/déploiement puis gate applicable. Aucun de ces contrôles d’intégration n’a été exécuté pour rédiger ce contrat.

## Sources relues et limites de preuve

| Source                                                                                                                                                                                   | Observation utilisée                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR-0001](./0001-primary-axis-packages-compose-apps.md), [ADR-0018](./0018-durable-execution-ownership.md), [GLOSSARY](../../../../GLOSSARY.md)                                         | Composition Packages/App, Organization, durable owner, admission/guards/reçus, absence de reprise App ou de double owner.                                                                                                     |
| [`workflow.ts`](../../../../apps/example-api/src/flows-run/workflow.ts), [`wrangler.toml`](../../../../apps/example-api/wrangler.toml)                                                   | Précédent natif `WorkflowEntrypoint`/`step.do`, binding App, local et production distincts, demo Queue actuel. Les types générés actuels exposent déjà `WorkflowDelayFunction` et `WorkflowStepContext.attempt`.              |
| [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)                                                                                                  | `create` avec ID choisi; erreur si ID encore existant sous rétention; `get/status`, rétention effective/overrides; configuration de retry dynamique.                                                                          |
| [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), [Step context](https://developers.cloudflare.com/workflows/build/step-context/)       | `retries.limit` compte les retries, délai fonction de `{ctx,error}`, nombres en millisecondes, `ctx.attempt` indexé à 1, catch d’un step épuisé pour finalisation.                                                            |
| [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Delivery guarantees Queues](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) | ID Workflow ≤100; rétention terminale Free trois jours, Paid sept jours pour les nouvelles définitions et trente jours pour les anciennes; limites CPU; différence entre déduplication d’instance et exactly-once de l’effet. |

À E0, le 2026-10-22, les sources CF officielles ont été lues directement; Context7 avait retourné `Monthly quota exceeded`, sans preuve runtime revendiquée. Pour E5, l’amendement accepté le 2026-11-06 a été exercé avec le helper privé réel dans le runtime natif : hint conservé, délai planifié et réveil sans accélération. Les preuves App/D1/Workflow et leurs limites sont décrites dans [testing](../../testing.md#notifications-email-delivery-owner); elles ne prouvent ni déploiement, ni rétention effective du compte, ni réception provider.
