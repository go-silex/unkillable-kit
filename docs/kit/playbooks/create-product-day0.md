# Create a Product: day 0

Use this in the fresh dedicated clone prepared by [Start a product](./start-product.md), after an operator creates the empty Product repository. The generator changes only that clone; repository creation, first push and deployment remain operator actions.

```bash
bash scripts/kit/create-product.sh <name> \
  --origin <owner>/<repo> --accept-parent-origin --commit [--web] [--mcp] [--skip-gh-default]
```

`<name>` is a lowercase slug beginning with a letter, at most 39 characters, using letters, digits and hyphens, with no trailing hyphen. `example`, `starter` and `mcp-example` are reserved. `--origin` identifies the Product, not an allowlisted Kit parent. `--accept-parent-origin` explicitly authorizes treating the current parent origin as a disposable clone; `--commit` authorizes two local commits with normal hooks and the existing Git identity. `--web` adds a web App. `--mcp` adds a Product-owned stdio App using `@kit/mcp` and `fastmcp`, with ping and whoami; hosted OAuth is a separate [composition decision](./start-product.md#core-vs-opt-in).

## Preflight

Run at the clone root, with a clean tree, no merge in progress, and a single independent worktree: the Git directory and common directory must coincide and `git worktree list --porcelain` must list only that worktree. The only remote must be `origin`, pointing to an allowlisted immediate parent. The inheritance marker and generated destinations must not already exist; required starters must be present. The generator refuses an already-rewired Product and does not resume partial runs. Preflight failures leave the clone untouched.

## Generated setup

1. The generator records the inherited parent tip, renames `origin` to `upstream`, adds the Product `origin` using the parent's HTTPS or SSH scheme, and sets the `upstream` push URL to `no_push`.
2. Normally it runs `gh repo set-default origin` and verifies the selected identity. This configures the local default and uses an authenticated read-only GitHub lookup; the empty Product repository must already exist and be visible. With `--skip-gh-default`, intended for fixtures and documentation, it skips this operation and reports that the `gh` default repository is **not configured**. It does not fake the local setting. Before any `issue-triage` write, configure and verify the real Product default.
3. It commits `config/product/inheritance.json` with the parent tip and the Product `.dev/stack.yml` values as `chore(product): pin kit inheritance`. The stack contains the Product API path, release component, optional web path or `frontend: null`, and the API `.dev.vars` worktree copy entry.
4. It copies `apps/starter-api` to `apps/<name>-api`, adapting package, Worker, D1, manifest, README and coverage identities while preserving migration bytes. `--web` similarly copies and adapts `apps/starter-web`; `--mcp` creates the stdio App. Packages use `@kit/<name>-api`, `@kit/<name>-web` and `@kit/<name>-mcp` as applicable. The API syncs the `core,audit` schema sets.
5. It materializes Product validation, CI, deploy-gate, agent entry point and coverage ordering from Kit templates, installs dependencies, stages App manifests, configures Dependabot and runs `zero-edit`. It commits the resulting Apps and wiring as `chore(product): bootstrap <name> apps`.
6. It runs `bun run validate:full` and `bash scripts/product/validate.sh`. Both must pass. It never creates a GitHub repository, pushes, deploys, runs `issue-triage`, or changes Git user identity.

## Failures and handoff

A failed `gh` lookup leaves the rewritten remotes in place. Ensure the Product repository exists and authentication can resolve it; run `gh repo set-default origin` and verify `gh repo set-default --view` equals the Product identity. The generator does not resume that partial state: finish the remaining setup manually or start again in a fresh clone. A failure after the first commit preserves that commit and the working tree for fix-forward; hook, Dependabot, zero-edit and validation failures are not bypassed. Do not reset or clean away partial work as a recovery instruction.

After successful validation, the operator pushes `main`, configures the CI App, runs `issue-triage init --dry-run` and checks its target and relabel count before any write, chooses Product license terms, and performs Cloudflare configuration and cutover. Details and safeguards remain in the [operator checklist](./start-product.md#day-0-checklist).

## Generator proof

Kit maintainers can run `bash scripts/kit/smoke-create-product.sh` from a committed Kit checkout to exercise fresh-clone Product combinations and generated-output dogfood. Pass `--real-origin <owner>/<repo>` for the authenticated, read-only GitHub default-repository proof against an existing repository. The default fictitious origin skips that proof and does not configure a `gh` default. This outer smoke is separate from `validate:full` because each generated Product runs that gate.
