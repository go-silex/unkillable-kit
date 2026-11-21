---
title: 'ADR-0018 — One durable owner per durable execution'
status: accepted
normative: true
date: 2026-10-18
amended: 2026-11-21
axial: false
related:
  - AGENTS.md
  - GLOSSARY.md
  - docs/kit/architecture/adr/0001-primary-axis-packages-compose-apps.md
  - docs/kit/architecture/adr/0005-flows-platform-agentic-workflows.md
  - docs/kit/standards/stack.md
  - docs/kit/product-consumer-contract.md
  - 'Roxabi/roxabi-boilerplate-cf#412'
summary: 'One durable owner per durable execution'
supersedes_notes: >
  2026-11-21: Context dates the pre-amendment Forbidden line; D5 lists the
  Delivery owner from ADR-0020. No decision changed.
---

# ADR-0018 — One durable owner per durable execution

Every durable execution has exactly one durable owner. This decision covers Kit and Product executions, including governed plan runs, job messages and conversations; it does not mandate Cloudflare Workflows for every execution kind.

## Context

The principle is in the title of [ADR-0005 D2](./0005-flows-platform-agentic-workflows.md#d2--runtime--cloudflare-workflows-do-not-reimplement-durable-engine): « do not reimplement durable engine ». D2's Forbidden line then scoped it: « custom DO workflow engine when Workflows suffice ».
The constitution kept the tool name and dropped the qualifier. Since Roxabi/roxabi-boilerplate-cf#412 that line forbids such engines even when Workflows do not suffice.

Invariant 6 literally binds every Product execution to Cloudflare Workflows, even when a supplied durable conversation runtime already owns it.
A Product cannot amend the inherited constitution; adding a Workflow on top would give one execution two owners.

What the Kit composes today:

- **Governed plan runs:** Cloudflare Workflows, the only implemented owner; `@kit/flows` writes its receipts inside the Workflow's steps ([`workflow.ts`](../../../../apps/example-api/src/flows-run/workflow.ts)).
- **Job messages:** Cloudflare Queues and Cron ([`stack.md`](../../standards/stack.md), row _Jobs_).

## Decision

### D1 — One durable owner per durable execution

Every durable execution, in the Kit or in a Product, has exactly one durable owner ([`GLOSSARY.md`](../../../../GLOSSARY.md) § Execution), which meets the D2 criterion. The rule has no list of exceptions: plan runs, conversations, job messages and any later kind fall under it.

**Forbidden:**

- hand-built durability, as D2 defines it;
- two owners for one execution.

### D2 — Owner criterion

The durable owner is the general-purpose runtime that persists an execution's progress and resumes the execution after an interruption. It was not written for that Product.

Kit or Product code composes on the owner at its interfaces (admission, guards) and inside its steps, where it may write and read records such as receipts, idempotency keys or audit rows. It may also call the owner's own API to deliver an event or to request a retry. Only the owner wakes an interrupted execution and re-enters it.

A queue message is one step. An attempt succeeds when it does all of that step's work; it could not go on when it hits an error or a result it awaits is not ready. A request for Queue redelivery follows only an attempt that could not go on, and the supplied owner counts it against its configured retry and dead-letter policy. Workflow step retry policy remains D4; a Workflow `restart()` is not a retry.

Hand-built durability is code outside the owner that resumes an execution from a progress record of its own, either itself (its own alarms, checkpoints or replay loops) or through the owner's API (a restart from a step that record chose). It stays hand-built in Kit code, in Product code and in a package extracted from either; extraction does not make it a general-purpose runtime.

Through the owner's API, that boundary includes three forms:

- **Continuation.** An attempt that could go on ends its step by `retry()` or a deliberate throw so a later re-entry does work it left untried, whatever selects it: a record, `message.attempts`, or external state. A consumer that records `stage=N+1` and retries is continuation; the owner's retry budget would count stages instead of failures.
- **Replacement.** Code starts a new execution that runs again work an attempt could not go on with, or a part an earlier attempt left untried that a code-owned record selects. Each new execution has a fresh retry budget. Catching a failure, acknowledging its message, and sending the same body again is replacement; so are acknowledging an acknowledged-not-ready poll and sending it again, or sending a record-selected next part in a fresh message.
- **Restart.** Code discards the owner's progress so a record decides what runs again. A governed-plan Workflow restart that resets deadline or wake-count bounds is forbidden whoever calls it; a person choosing to restart a non-plan Workflow is a redrive.

Work split after a successful stage either stays one execution under an owner that persists each stage as its own step, or composes distinct executions under D3: the successful stage sends a next message whose own input names the next stage.

A record that prevents a repeated effect stays a receipt when the owner's own retry or redelivery follows an attempt that could not go on, or when an at-least-once duplicate follows a prior success: an owner retry can skip completed effect A and retry genuinely failed effect B. A redrive is a person explicitly choosing each rerun of a dead-lettered or acknowledged-failed job; general supervision of an automated forwarding consumer, cron, standing flag, or dead-letter cycle is not that choice and is replacement.

A queue with retries and a dead-letter queue is a supplied owner for a job message. Cron is a trigger, never an owner.

No Kit gate checks this criterion. The review by an agent independent of implementation that [`AGENTS.md`](../../../../AGENTS.md) § Hard agent rules requires for durable execution ownership changes checks it, a Product ADR written under D5 included.

### D3 — Distinct executions compose

Distinct durable executions may have different owners and may call one another. Work that an execution's owner already resumes after an interruption is part of that execution, whatever it is called, except a governed plan run: a plan run is always its own execution, under the owner D5 names for it, whatever execution starts or drives it. Only one execution with two owners is forbidden.

### D4 — Orchestration on top of the owner

Kit or Product code may define steps, conditions and retry policy on top of the owner's durable primitives, within the D2 boundary.

### D5 — Kit-composed owners and the Product ADR trigger

| Execution             | Owner the Kit composes                                                                               | Decided in                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Governed plan run     | Cloudflare Workflows, the only implemented adapter                                                   | [ADR-0005](./0005-flows-platform-agentic-workflows.md) D2 and its Roxabi/roxabi-boilerplate-cf#412 amendment           |
| Job message           | Cloudflare Queues; Cron only triggers, and a Product's consumer sets retries and a dead-letter queue | [`stack.md`](../../standards/stack.md), row _Jobs_, for Queues and Cron; D2 for the trigger and dead-letter conditions |
| Notification Delivery | Cloudflare Workflows, one Workflow per Delivery with a stable instance ID                            | [ADR-0020](./0020-notification-delivery-ownership.md)                                                                  |

Another owner for governed plan runs requires a new Kit ADR. A Product records every other unlisted execution-type/owner pairing in an accepted ADR under `docs/product/`; that ADR maps each of its durable execution types to its owner.

## Non-claims

- Choosing a durable owner proves nothing about authentication, Organization isolation, authority ceiling, budget, effect safety or execution history.
- A Product's choice of owner is neither durable workflow proof nor a second consumer for the Agents layer gate ([platform direction](../platform-direction.md#capability-sequence)).
- Invariant 7 is unchanged.

## Consequences

### Positive

- The constitution states the principle, and a Product inherits it without a waiver.
- Governed plan runs keep their implemented owner, so no Kit code changes.

### Negative

- The rule is enforced only by the independent-agent review D2 names, not by a gate.
- Every runtime a Product adds brings its own limits, failure modes and operations, which that Product owns.

## Alternatives rejected

| Alternative                                                           | Why rejected                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Keep Cloudflare Workflows as the only owner                           | A conversation on a supplied runtime would need a Workflow on top: two owners for one execution, the defect D1 forbids |
| A closed list of exceptions to Workflows                              | Every new execution kind reopens the constitution; the D2 criterion covers them once                                   |
| A Kit-maintained allowlist of runtimes                                | The Kit would evaluate Product runtimes it does not compose, and the list would age with every release                 |
| Kit-specified Product obligations (authentication, isolation, budget) | Product concerns in Kit text that no Kit gate can check; the non-claims name them and each Product decides them        |

## Refs

- Kit issue [Roxabi/roxabi-boilerplate-cf#412](https://github.com/Roxabi/roxabi-boilerplate-cf/issues/412)
- [`AGENTS.md`](../../../../AGENTS.md) § Seven invariants, invariant 6
- [ADR-0005](./0005-flows-platform-agentic-workflows.md) D2
