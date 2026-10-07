# Evaluation results (live LLM)

Measured on 2026-10-07 against OpenRouter. Agent runs go through the in-process gateway (real policy engine, no side effects).

**Provenance and scope — read first.**

- Model IDs are the **current OpenRouter catalog** as of this date (verifiable via `GET https://openrouter.ai/api/v1/models`); several 2024-era names such as `claude-3.5-sonnet` are no longer served. Raw per-run outputs (token counts, latencies, per-case decisions) are committed under `apps/supportops-agent/evals/results/`.
- **Sample size is small: 24 hand-written scenarios, one run per model.** With LLM non-determinism, a single case moves a model's score by ~4 points. **These are directional smoke-test results, not a statistical benchmark.** Do not read model-economics conclusions into them; a real benchmark needs hundreds of randomized vectors and multiple runs per cell with confidence intervals.
- What _is_ robust here are the **deterministic** results, which do not depend on the LLM and are repeatable: the concurrency/crash tests (Phase 2/4), the 32-case red-team suite, and the 30-case e2e suite. Those are the load-bearing evidence; the agent evals below are a quality signal on top.

## 1. Retrieval: vector beats BM25, and beats hybrid on unseen queries

`pnpm eval:retrieval` · embeddings `openai/text-embedding-3-small`

| Retriever      | dev recall@5 | dev MRR | **held-out recall@5** | **held-out MRR** |
| -------------- | ------------ | ------- | --------------------- | ---------------- |
| BM25 (lexical) | 0.97         | 0.87    | 0.75                  | 0.65             |
| **Vector**     | 1.00         | 0.99    | **0.92**              | **0.92**         |
| Hybrid (RRF)   | 1.00         | 0.95    | 0.83                  | 0.74             |

**Findings.** The held-out set (written after tuning stopped, never used to tune) is the honest measure. Vector retrieval closes the lexical gap that BM25 can't: held-out recall@5 rises 0.75 → 0.92. Unexpectedly, **hybrid (RRF) is worse than vector alone** on held-out (0.83) — fusing in BM25's weaker rankings drags the strong vector order down. Action: default to vector retrieval, or weight RRF toward the vector list, rather than assuming hybrid always wins.

## 2. LLM-as-judge is well calibrated, but variable

`pnpm evals:judge-calibrate` · judge `anthropic/claude-sonnet-5` vs 24 hand labels

- **96% agreement, Cohen's κ = 0.92** (strong; well above the 0.6 trust bar).
- Confusion: tp 11, tn 12, fp 1, fn 0 — one false positive (the judge was stricter than the author on a polite-denial reply).
- **Judge variance observed in use:** the same "I've refunded the $15" reply pattern scored faithfulness 5 in calibration but 2 in the agent eval. A single judge pass is a useful signal, not ground truth; deterministic checks remain the gate.

## 3. Agent quality across models (directional, n=24)

`pnpm evals -- --models … --judge` · **24 scenarios, single run per model** · judge `anthropic/claude-sonnet-5`

| Model                   | task pass | judge pass | policy saves | p50  | p95  | cost / case | **hard-safety breaches** |
| ----------------------- | --------- | ---------- | ------------ | ---- | ---- | ----------- | ------------------------ |
| openai/gpt-5.6-luna     | 96%       | 62%        | 4            | 5.3s | 7.6s | $0.0006     | **0**                    |
| openai/gpt-5.4-mini     | 83%       | 62%        | 7            | 3.9s | 4.4s | $0.0025     | **0**                    |
| google/gemini-2.5-flash | 92%       | 58%        | 6            | 3.1s | 4.1s | $0.0008     | **0**                    |

"Hard-safety breach" = a refund to another customer, a refund over the limit, or a blocked tool being **allowed**. There were none in this run, for any model.

**How to read this (and how not to).**

- The "0 breaches" column is **not a discovery** — it is the expected consequence of the design, and this run is a check that the design behaves as intended, not evidence that it is novel. The hard invariants (argument-level authorization against server-side case data, numeric thresholds, aggregate limits, blocked-tool list) are enforced in deterministic code _below_ the model, so model quality cannot change them. A principal engineer should read this as "the guardrails were exercised by three different drivers and none got around them," nothing grander. The non-trivial part is _where_ the check happens (against stored case data, not the agent's claimed arguments — the confused-deputy defense), not that a check exists.
- **Do not draw cost/quality conclusions from this.** gpt-5.4-mini scored lowest here despite costing more, but at n=24 with single runs that is within noise. The honest statement is only: "on these 24 scenarios, cost did not predict task-pass rate — which is a reason to measure per use case, not a general law."
- **Task-pass vs judge-pass gap is reply-quality nuance, not safety.** Most judge failures are the "has been refunded" wording (the refund is issued but settles in days) and occasional invented links. That is polish for a cheap model, not unsafe behaviour. Judge scores also vary run-to-run (§2), so treat ~60% as a soft signal.
- **The load-bearing safety evidence is deterministic and repeatable**, not these LLM runs: `pnpm e2e` (10 concurrent approvals → exactly 1 Stripe refund), `pnpm redteam` (32/32 adversarial cases blocked), and the `kill -9`-under-load test (0 lost/duplicated events). Those don't move with model choice or sample size.

What this project actually is, stated plainly: standard enterprise patterns — API authorization, policy evaluation against trusted state, a transactional outbox, idempotent consumers, effectively-once execution — **applied to untrusted agentic tool calls**. The contribution is the application and the correctness testing, not a new safety concept.

## How to reproduce

```bash
# .env needs OPENROUTER_API_KEY (and Postgres/Redis up for the stack suites)
pnpm eval:retrieval
pnpm evals:judge-calibrate
pnpm evals -- --judge
pnpm evals -- --models openai/gpt-5.6-luna,openai/gpt-5.4-mini,google/gemini-2.5-flash --judge
```
