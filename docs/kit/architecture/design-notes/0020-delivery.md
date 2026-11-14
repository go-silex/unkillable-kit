# ADR-0020 design note

Non-normative. Extracted from ADR-0020 on 2026-11-14. Binding only once an accepted ADR amendment adopts it when the code is implemented.

## Retry-After

L’adaptateur Slack parse `Retry-After` en entier sûr non négatif; une valeur invalide est omise et zéro est normalisé à une seconde. L’adaptateur ne tronque pas une valeur valide à 24 h, n’effectue ni sleep ni retry et conserve le résultat `retryable`; le Workflow applique le budget local.

## Demo configuration

J1 devient l’alignement du demo : retries bornés et DLQ explicitement configurés dans ses deux consumers existants, docblock/runbook cohérents, boucle App par message. Configuration : `max_retries = 5`, `retry_delay = 60`, batch 10 et timeout 5 inchangés; DLQ `example-api-demo-dlq` en local simulé et `boilerplate-api-demo-dlq` en showcase. Ce changement de déploiement reste soumis à la revue indépendante. Il ne crée pas d’environnement staging et ne transforme pas l’Example App en point de départ à copier.
