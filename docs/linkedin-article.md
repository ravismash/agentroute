# Letting an AI agent issue refunds — without trusting the AI with the decision

I spent the last few weeks building **AgentRoute**, a policy gateway that lets an AI support agent take real business actions — issue a refund, change a plan — while a deterministic layer, not the model, makes the final call. The agent _proposes_; the gateway _decides_ (allow / approval_required / deny) against versioned rules, executes the stored decision, and audits everything.

The interesting problems weren't in the prompt. They were the old distributed-systems problems, wearing a new hat. Four that were worth the scar tissue:

## 1. The ghost action

An agent proposes a $15 refund. Policy allows it. The gateway calls Stripe — and the network times out before the response comes back. Did the refund happen or not?

A timeout is not a failure. It's an _indeterminate_ outcome, and the wrong move is to blindly retry (double refund) or blindly give up (customer never refunded). I handle the two cases differently:

- **Within one execution attempt**, the Stripe call carries a stable idempotency key — `agentroute:<action_id>:<attempt>`. So any network- or SDK-level retry _inside_ that attempt can't double-charge; Stripe returns the original result.
- **An indeterminate outcome is never blindly retried.** Reconciliation asks the provider what actually happened: I stamp `metadata.action_id` on every refund, then query Stripe's refunds for that action. If a matching refund exists → the action succeeded. If not → it's safe to try again, as a _new_ attempt with a _new_ key (so a genuinely-failed attempt isn't stuck replaying a cached failure).
- **A database uniqueness constraint** — one successful execution row per action — is the final backstop. Even a logic bug can't record two successes.

So "exactly once" is really _at-least-once execution + an idempotent provider call + reconciliation of the unknown case + a unique-success constraint_ = **effectively once**. The key insight: don't trust your own retry logic to know whether the side effect happened — ask the system that owns the side effect.

## 2. The microsecond truncation trap

The approval queue is cursor-paginated, ordered by when each action was requested. Early on, a reviewer paging through would occasionally see the same row twice across page boundaries.

The cause: Postgres `timestamptz` has **microsecond** precision; a JavaScript `Date` has **millisecond** precision. Serialising the cursor timestamp through JS silently truncated the last three digits. Two actions requested 400µs apart collapsed to the same millisecond, and the keyset cursor `WHERE requested_at > $cursor` either skipped or repeated the boundary row.

Fix: carry full-precision timestamps in the cursor and add `action_id` as a deterministic tie-breaker, so the ordering is total even when two timestamps are equal. A boring bug with a sharp edge — and exactly the kind of thing unit tests caught before a human ever did.

## 3. Decoupled decision paths

The decision (allow/deny) must be durable and fast. The _side effects_ of a decision — audit log, daily stats — must never be lost, but also must never slow down or fail the decision path.

So the decision transaction writes the action, the decision, and an **outbox** row in one atomic commit. A separate worker relays outbox rows to Redis Streams, where idempotent consumer groups build the audit log and stats. The Postgres outbox is the source of truth; Redis is a replayable transport. Consumers dedupe on a stable event id, so redelivery is harmless; poison messages land in a dead-letter queue with a replay CLI; and if Redis loses data, I rebuild the stream from the outbox.

I tested this the rude way: `kill -9` on the worker under live traffic while the API kept serving. 12 events buffered during the outage, and after restart all 62 events were delivered exactly once — zero lost, zero duplicated.

## 4. Never re-prompt after approval

The subtlest one. A $299 refund needs human approval. The operator clicks approve. What executes?

The tempting design is to re-invoke the agent to "carry out" the approved action. That's a security hole: the model could now propose _different_ parameters than the ones the human reviewed. So AgentRoute executes the **stored, immutable proposal** — the exact amount, customer, and reason the operator saw. A database trigger makes the action's parameters immutable after creation; the LLM is never in the loop again for that decision. The human approved a specific thing, and that specific thing is what happens.

---

## What this actually is (and isn't)

I want to be honest about the claims. The agent results are **directional, not a benchmark**: 24 scenarios, one run per model. What's robust is the _deterministic_ part — across three current models, the hard invariants held (no cross-customer refund, no over-limit refund), because they're enforced in code _below_ the model, not by the model. Retrieval is measured: vector search lifts held-out recall@5 from 0.75 (BM25) to 0.92, and the LLM-as-judge calibrates at Cohen's κ 0.92 against my hand labels.

None of this is a new safety concept. It's standard access-control, transactional-outbox, and idempotency patterns — applied to untrusted _agent tool calls_ instead of untrusted user input. The work is the application and the correctness testing, not an invention. I think that's the honest framing for most "agent safety" work right now: the model is a proposer, and the guarantees come from the boring, testable layer underneath it.

It's live, open source, and documented (7 ADRs, a threat model, a design doc). Link in the comments.

**A question for people building agents that touch real systems:** when your provider call times out and you genuinely cannot tell whether the side effect happened, do you reconcile against the provider (as I did), rely on a stable idempotency key and the provider's dedupe window, or something else? Where has that bitten you?
