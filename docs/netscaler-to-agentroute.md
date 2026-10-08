# From NetScaler policies to agent policies

AgentRoute is not a pivot away from what I spent a decade on — it's the same problem in new clothes. At Citrix/NetScaler I built policy engines: the machinery that sits in the request path and decides, deterministically and fast, what traffic is allowed to do. AgentRoute applies that discipline to a new kind of untrusted client — an LLM agent — instead of an HTTP client.

This doc is the explicit mapping, because the transferable part is the _engineering stance_, not the product.

## The shared thesis

A policy engine earns its place by being **deterministic, fast, fail-closed, and auditable** while sitting in front of something you don't trust. On NetScaler that "something" was the open internet. In AgentRoute it's a model whose output is attacker-influenceable via prompt injection. The threat model rhymes:

| NetScaler world                                                                | AgentRoute world                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Untrusted HTTP clients                                                         | Untrusted LLM proposals                                                                    |
| Policy expressions evaluated per request in the data path                      | `evaluate(policy, proposal, context, usage)` per proposal                                  |
| Default-deny ACLs, bind order, "most specific wins"                            | Default-deny, deny-overrides, escalation "most severe wins"                                |
| Content switching / responder acting on _server-side_ facts, not client claims | Context binding: args checked against case/subscription data, not the model's claims       |
| Rate limiting & connection caps per entity                                     | Per-key/tenant rate limits + aggregate refund limits (Phase 5)                             |
| Config versions with rollback; nothing ships unvalidated                       | Versioned YAML policies, validate + dry-run before activate, one active version per tenant |
| The data path must not wedge on a control-plane fault                          | Fail-closed on policy/budget error; decision path never blocks on audit/telemetry          |

## Four lessons that carried over directly

**1. The decision must be deterministic and cheap.** A NetScaler policy expression can't "sometimes" allow a request, and it can't take 300 ms — it's in the data path. AgentRoute's policy engine is a **pure function**: YAML compiled to a per-tool rule index, no I/O in the evaluation itself (usage/context are injected), so it's trivially unit- and property-testable and runs in well under the decision-latency budget. The LLM is explicitly _not_ in this path — it proposes beforehand; the engine decides.

**2. Fail-closed is a feature, not an error state.** On an appliance, when policy evaluation can't complete, you deny — you do not fail open and let unclassified traffic through. AgentRoute does the same: a `UsageReader` error, a budget-service outage, an unparseable policy → `deny` / `POLICY_EVALUATION_ERROR`, never a silent allow. Availability is sacrificed to safety exactly where money is involved, and that boundary is drawn deliberately (see the CAP table in [design.md](design.md)).

**3. Bind to server-side truth, never client claims.** The single most important NetScaler habit: decisions key off facts the box can verify, not headers the client asserts. AgentRoute's highest-value control is the same move — "refund customer C-999" is denied not by detecting a bad prompt, but because C-999 isn't the customer bound to this case server-side. You don't out-clever the attacker's text; you make the text irrelevant to the decision.

**4. Config is versioned, validated, and rollback-able — always.** Nobody sane pushes an un-validated ACL change to production and hopes. Policies here are versioned, dry-runnable against historical proposals ("what would this change have decided?"), activated atomically (one active version per tenant via a partial unique index), and reversible. Change management _is_ part of the engine, not an afterthought.

## What's genuinely new

Three things didn't exist in the appliance world and are where the learning was:

- **Effectively-once execution of side effects.** NetScaler mostly allows/denies/steers; it rarely _executes an irreversible downstream action_ itself. Issuing a real refund means owning idempotency, reconciliation of indeterminate outcomes, and a unique-success invariant — distributed-systems work, not packet work. (See [ADR-0003](adr/0003-effectively-once-execution.md).)
- **A non-deterministic client you must still bound.** An HTTP client is dumb; an LLM is capably wrong. That forced the "propose vs. decide" split and the "never re-run the model after approval" rule ([ADR-0004](adr/0004-execute-the-stored-proposal.md)) — the model stays firmly outside the trust boundary.
- **Grounding and evaluation.** Judging whether the agent's _reply_ is faithful to what actually happened (not just whether the action was allowed) has no appliance analog — it's retrieval, LLM-as-judge, and calibration ([ADR-0006](adr/0006-grounding-retrieval-and-judged-evals.md)).

## The one-line version

I spent ten years making sure an untrusted client could only do what deterministic, versioned, fail-closed policy permitted — in the request path, auditable, at line rate. AgentRoute is that same engine pointed at the newest untrusted client we have. The novelty is the client and the irreversible actions; the discipline is the part I already knew was non-negotiable.
