# Platform direction — multi-tenant capability kernel

This direction is subordinate to the mission, precedence and seven invariants in [AGENTS.md](../../../AGENTS.md) and to accepted normative ADRs. It is not an implementation backlog.

## Purpose and evidence

- **Developer JTBD (P0):** a developer can clone the kit and run green `example-api`, `example-web` and `mcp-example` gates, with demo auth, UI, centralized errors, FR/EN i18n and a local email catcher, without product-domain strings.
- **Platform JTBD:** a product composes the multi-tenant kernel, an organization runs a governed plan, and a second product composes the runner without forking it. Examples, pure flows and MCP alone do not establish this claim.
- **Dogfood:** `example-*` is synthetic; a zero-edit product tests the [consumer contract](../product-consumer-contract.md); only a real external product deployment can demonstrate the platform JTBD.

### Platform proof

The platform JTBD is **not met**: the tenant shell is partial, governed execution on a named product tenant is not proven, and a second product composition is not proven. The example durable run path and approval route do not waive these requirements. D1 is met only when its gates are green.

- **D1 — developer:** lint, typecheck and test the three examples; keep product-domain strings out of packages and examples; exercise zero-edit and deny-upstream gates on the consumer path.
- **D2 — tenant:** demonstrate invitation and membership, fail-closed organization context, module enablement and the appropriate session or org-bound API key.
- **D3 — governed plan:** on a named external product tenant, demonstrate plan parsing and validation, server-minted grants, narrowing permits and fail-closed effects, an immutable run snapshot, durable Cloudflare Workflows execution, the applicable admin/principal gate, principal-bound side-effect approval and observable outcomes or receipts. The example approval route accepts session plus org admin, not `sk_`; Workflow events are wake-only.
- **Second compose:** demonstrate another product or app call site composing auth, modules and the flows runner without forking the runner or copying its run tables into a local god module. Promotion still requires ADR-0005 D6's stable schema, example dogfood and second call site.

Mark the platform JTBD met only with linked evidence for D2, D3 and the second compose, naming the product repository, organization, deploy and workflow. Agents are outside this proof: their tools must share registry ∩ grants with flows, and an agent package requires D3, a second call site and a spend meter for multi-step loops.

## Capability sequence

| Layer     | Kit                                                                                    | Product                                             | Gate                                                                                                              |
| --------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SaaS      | Auth, core, database, UI, storage, email, i18n and types                               | Modules, routes, seed and domain                    | [ADR-0001](./adr/0001-primary-axis-packages-compose-apps.md), [ADR-0003](./adr/0003-multi-tenant-rbac-modules.md) |
| Workflows | `@kit/flows`; console stays in the example until a second consumer justifies promotion | Plans, tools, Workflows binding and database wiring | [ADR-0005](./adr/0005-flows-platform-agentic-workflows.md) D6                                                     |
| Agents    | MCP conventions; shared registry or loop only with repeated use                        | Product tools, MCP server and optional code mode    | After durable workflow proof and a second call site; no speculative `@kit/agents`                                 |

The kit's green developer path wins over platform growth. Flows and tasks/comments incubate under their ADRs; [ADR-0007](./adr/0007-tasks-comments-kernel.md) governs tasks and comments. Shared MCP/flows registry types, if promoted, replace both existing factories rather than adding a third. Agent loops and code mode require evidence and an appropriate decision before becoming kit scope.

## Isolation and governance

A product deploy owns its Worker, database, bindings and secrets. An `organization` is the tenant, including a solo organization; users, agents and runs are actors within its grants, not separate tenants. Cross-product identity is a product/SSO concern, not a kit guarantee. An immutable run snapshot isolates execution from later edits; an agent has no inherent privilege.

Governed execution mints grants server-side, checks before execution, narrows grants through permits and registry, binds side-effect approval to a principal, and meters budgets. Empty authority fails closed. Static ceilings alone do not enforce runtime budgets; do not advertise `net` or `r2` permits before enforcement wrappers exist. See [ADR-0005](./adr/0005-flows-platform-agentic-workflows.md) and [ADR-0018](./adr/0018-durable-execution-ownership.md) for binding details.

## Boundaries

Products compose packages; the kit is not a productivity OS, gadget shell, per-file app host or company-context monorepo. Product plans, prompts and domain belong downstream, not in `packages/*` or synthetic examples. No ambient tool registries, broad connector allowlists, unauthenticated Workflow approval, shell/exec or free-form code mode as kit defaults; code mode is product opt-in only. API keys must not gain create-run and high-permit tools without scoped minting.

The Cloudflare Workers/D1/R2 kit is Chemin A; Chemin B is a separate Next and Neon/Supabase boilerplate. Chemin A deployment follows green CI; CI remains blocking before merge and deploy. See the [stack standard](../standards/stack.md) for technical choices.
