# GitHub App `kit-ci` — setup (no PAT)

This runbook describes configuration for the maintained implementation, not a claim that any repository or GitHub App has been provisioned. The recommended setup uses one GitHub App dedicated to the target repository, without a PAT or a separate authorization App, installed only on that repository with a fresh repository-level PEM secret. A shared installation requires the explicit [owner exception](#shared-app-owner-exception) below. A short-lived installation token does not narrow the private key itself.

## Trust and setup

Repository administrators, App managers, configured human operators, and trusted default-branch writers and dispatchers are in the trust boundary. Restrict who can change workflow definitions, Actions variables, the App installation and its key. GitHub administrators and writers can bypass process; this is not a defense against malicious trusted principals.

1. Create the target-only GitHub App, or use the installation covered by an explicit shared-App exception. Disable its webhook unless separately required. Store its PEM as the repository Actions secret `CI_APP_PRIVATE_KEY`; never commit or print it.
2. Set repository Actions variable `CI_APP_ID` to the App's Client ID for token minting. Record the same App's **numeric App ID**, distinct from the Client ID, and its **numeric bot user ID** from GitHub. Obtain the target repository's immutable numeric ID and the numeric GitHub user IDs of trusted human operators from GitHub, not from display names.
3. Set the following repository Actions variables. The operator list is a JSON array of numeric IDs, not logins or strings. On Free private repositories use repository-level values rather than relying on organization-level Actions values.

   | Variable | Value |
   |---|---|
   | `HEAD_AUTH_REPOSITORY_ID` | Target repository's numeric ID |
   | `HEAD_AUTH_OPERATOR_IDS` | JSON array of trusted human numeric user IDs |
   | `HEAD_AUTH_APP_ID` | Numeric ID of the installed CI App |
   | `HEAD_AUTH_BOT_USER_ID` | Numeric user ID of that App's bot |
   | `CI_APP_ID` | App Client ID used to mint tokens |

4. Grant the installed App repository **Contents: read and write**, **Workflows: read and write**, and **Pull requests: read and write**; GitHub supplies Metadata read. The merge token requests `contents: write` and `workflows: write` so it can merge workflow-pin changes. The separate PR comment/label publication token requests `pull-requests: write`, not `issues: write`. Gate reads use a separate read-only `GITHUB_TOKEN`; the App's union of permissions does not mean every minted token receives that union. Other inherited consumers may require additional permissions, such as Dependabot alerts read for the optional alert workflow.
5. Confirm the implementation is present on the default branch and the effective variables and secret are available to the intended workflows. An absent `CI_APP_ID` disables automated writes: a complete valid authorization policy permits read-only merge evaluation, while an absent policy skips evaluation. An operator must perform a separately authorized manual merge. A nonempty ID with a missing key is a configuration failure, not inactive mode. Confirm an actual mint only in a separately authorized operational exercise: dispatch may also merge eligible PRs.

All `HEAD_AUTH_*` variables must be valid together. Plugin discovery treats all absent as unconfigured **only after complete successful pagination**; that does not automatically select native protected-auto mode. Partial, malformed, unreadable or 403 responses fail closed. Preserve the existing native protected-auto mode when it is explicitly selected by its own process.

With `CI_APP_ID` absent, all-absent `HEAD_AUTH_*` is a successful inactive workflow mode: no policy parsing, evaluation, token mint or automated receipt write occurs. A complete supplied policy is still validated and permits read-only merge evaluation, but cannot enable automation while the App is disabled. Default-ref automation requires a complete valid policy whenever an App identifier or any policy value is supplied; partial or malformed policy remains an error. The unprivileged `pull_request` no-op is filtered before runner allocation; its defensive preflight return still avoids loading an adapter that may not exist on a consumer's inheritance PR. Comment wakeups, revocation and Dependabot capture retain strict validation; capture remains App-gated because it withdraws authorization before evaluation.

Payload filters avoid ordinary comments and other provable no-ops; they do not authorize a merge. The trusted preflight still validates policy and rereads protocol comments. See the [wakeup contract](./testing.md#merge-wakeup-contract) for event delivery and recovery limits.

## Shared-App owner exception

An owner may explicitly accept one shared merge App within an operating organization. This is an exception to the target-only recommendation, not equivalent isolation: compromise of a PEM available in a public repository can affect every repository reachable by that App, including private repositories. A small trusted human maintainer set does not remove that exposure.

- Approve the installation and credential-reader scope before enabling automation. Keep the operational inventory and audit details outside public issues; publish only the decision and its non-sensitive limits.
- Configure each repository's own immutable ID and authorized human issuers. Keep App/bot identity consistent with the installed App and scope minted tokens to the target repository and required operation. These token restrictions do not contain a stolen PEM.
- Preserve exact-head receipts, withdrawal, required checks and trusted executable provenance. External issue or PR authorship never grants merge authority or permission to execute contributed code with credentials.
- Supply repository-level credentials and policy for private repositories on GitHub Free. Review organization-secret distribution before a public repository can inherit it; one organization's accepted exception grants no authority in another.
- A confirmed key leak requires revocation and coordinated recovery for the affected installation. Neither a successful mint nor an approved exception proves least authority or completes the publication audit.

An existing accepted installation needs no new App merely to use the same merge implementation. Enable it only after repository policy, intended readers and actual mint/merge behavior have been verified under separately authorized conditions.

## Reviewed-head authorization

The maintained gate uses authenticated PR comments as a grant/withdraw protocol, not labels as authority. An admitted grant binds the immutable repository ID, PR database ID and number, exact head SHA and base branch. The existing native admission owner issues a native grant after its own review, integrity and budget rules; the manual path requires an explicit reviewed SHA and opaque evidence reference from a configured human operator, and still respects native ownership and admission. No new review, allowance or budget owner is introduced. Dependabot's separate automatic lane binds the evaluated base SHA as well as head; reviewed grants record base SHA as evidence but do not universally invalidate merely because the base advances.

Each attempt captures the newest authenticated predecessor before admission. It rechecks the scope and predecessor before publishing, then reads back the exact active receipt. A withdrawal denies all lanes; publish and confirm it before stopping, starting a review or a protected push. After withdrawal or conflict, a fresh explicit admission and issuance is required: never silently rebase an in-flight attempt. An ambiguous write is reconciled only by the same operation ID and exact payload, not a blind retry.

Readers paginate the entire authenticated protocol stream and select its newest numeric record across heads and lanes, not the newest matching desired head. Human issuer identity is checked against the numeric allowlist; machine identity must match both the numeric App and bot IDs, with the real Dependabot PR author for the machine lane. GitHub GraphQL proves the selected comment's identity, repository/PR association and `lastEditedAt` is null. Malformed, wrong-scope or edited newest records, duplicate selected operation IDs, missing predecessors, failed pages, partial GraphQL results and API errors hold rather than falling back to an older grant. Ordinary comments and untrusted copied markers are not issuers.

The gate queues the exact receipt during evaluation and requires that same receipt after fresh checks immediately before the SHA-pinned merge. A replacement receipt, even for the same head, requires a new evaluation. Labels are at most wakeup hints; neither a surviving label nor a successful token mint proves admission. Trusted `issue_comment` events, workflow completion and default-ref dispatch can wake evaluation. A dispatch scans eligible open PRs, not only its optional priority input. Privileged jobs use trusted workflow code and do not execute PR-head code with credentials.

Initial evaluation checks admission before quality: an unadmitted PR is reported with its authorization reason, not a green quality verdict. Admitted PRs receive the complete quality assessment. At landing, fresh quality precedes the final fresh authorization read and exact-receipt comparison.

The completion filter is intended to cover arbitrary workflow names while excluding the reserved gate name. See the [wakeup contract](./testing.md#merge-wakeup-contract) for bounded hosted evidence and delivery limits. Automatic evaluations without candidates do not mint a merge token; default-ref dispatch retains the configured-App mint diagnostic even with no candidates. Neither wakeup nor mint proves admission.

## Holds, repair and residual risk

- Inspect the current PR, head, scope, issuer configuration, comment stream and API errors. Repair missing permissions or invalid variables; a failed withdrawal is not a confirmed disarm. After a confirmed withdrawal, perform fresh source admission and explicit reissue for the current head. Do not delete a denial to restore authority.
- Assess [API capacity](./testing.md#merge-wakeup-contract) per repository before admission or rollout. A rate-limit error or budget overrun calls for holding new admissions and an operator-approved containment or rollback decision. Disabling automation or limiting wakeups is separately authorized mitigation with manual recovery, not a correction; a rollback must retain admission, revocation and required-check success.
- Append-only is a publisher contract, not immutable GitHub storage: trusted deletion or editing away of history can erase a fence. Returning to identical head A without an accepted withdrawal can match A again; a grant for A never authorizes B.
- GitHub reads and merge are not atomic. Changes after the final read and old or alternative workflow definitions remain residual risks. A default-ref guard cannot constrain an older definition.
- On GitHub Free private, merge-on-green is process, not branch protection: writers can merge or push without the gate. Never claim labels enforce checks or review. See [testing.md](./testing.md#merge-residual-github-free-private).

## Workflow consumers and operations

| Workflow | Role |
|---|---|
| `merge-on-green.yml` | Evaluates the exact receipt and current checks; scoped App token performs the merge |
| `dependabot-automerge.yml` | Withdraws, captures and evaluates an immutable head/base, then publishes only an allowed machine receipt |
| `deploy-gate.yml` | Uses the CI App for a separately decided deploy-branch promotion |
| `dependabot-alert-slack.yml` | Optional alerts; may require Dependabot alerts read |

For a new Product, follow [the consumer contract](./product-consumer-contract.md) and [start-product playbook](./playbooks/start-product.md); configure the recommended target-only App, or an explicitly approved shared installation, with repository-level credentials rather than editing inherited Kit workflows. For rotation, generate a new key for that App, update every intended reader in the approved scope, verify the new mints under separately authorized conditions, then revoke the old key. A partial or unverified rotation is not complete.

For an authorized smoke exercise, record the PR and exact head, independent review, applicable green checks, selected receipt, run and observed mint/merge outcome without exposing secrets. A skipped mint is not a successful mint; a successful mint alone proves neither authorization nor live enforcement. No smoke exercise is performed by this runbook.

## Related

- Environments (product git staging/main → Wrangler → CF; kit HEAD is `main` only): [`docs/kit/environments.md`](./environments.md)
- Cloudflare deploy (account-agnostic + local profile): [`docs/kit/deploy-cloudflare.md`](./deploy-cloudflare.md)
- Product start playbook: [`docs/kit/playbooks/start-product.md`](./playbooks/start-product.md)
