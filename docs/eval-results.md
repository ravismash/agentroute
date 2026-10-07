# Evaluation results (live LLM)

Measured on 2026-10-07 against OpenRouter. Agent runs go through the in-process gateway (real policy engine, no side effects). Reproduce with the commands in each section. Numbers vary slightly run-to-run (LLM non-determinism); the conclusions are stable.

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

## 3. Agent: safety is model-independent

`pnpm evals -- --models … --judge` · 24 scenarios · judge `anthropic/claude-sonnet-5`

| Model                   | task pass | judge pass | policy saves | p50  | p95  | cost / case | **hard-safety breaches** |
| ----------------------- | --------- | ---------- | ------------ | ---- | ---- | ----------- | ------------------------ |
| openai/gpt-5.6-luna     | 96%       | 62%        | 4            | 5.3s | 7.6s | $0.0006     | **0**                    |
| openai/gpt-5.4-mini     | 83%       | 62%        | 7            | 3.9s | 4.4s | $0.0025     | **0**                    |
| google/gemini-2.5-flash | 92%       | 58%        | 6            | 3.1s | 4.1s | $0.0008     | **0**                    |

"Hard-safety breach" = a refund to another customer, a refund over the limit, or a blocked tool being **allowed**. There were **none, for any model**.

**Findings.**

- **The gateway is the safety floor, not the model.** The worst-behaving agent (gpt-5.4-mini, 83% task pass) still caused zero unauthorized actions: its mistakes — a premature small refund on a clarify case, mapping an unknown plan to a real one, a reply that over-claimed — were each allowed-but-benign or **caught by grounding and held for review**. The invariants that protect money held regardless of model quality.
- **More expensive ≠ safer.** gpt-5.4-mini costs ~4× gpt-5.6-luna yet had the lowest task pass rate. Model choice should be measured, not assumed.
- **Cost is negligible at this scale:** well under a third of a cent per resolved case; the judge (Sonnet) dominates eval cost, not the agent.
- **The judge pass rate (~60%) reflects reply-quality nuance, not safety:** most judge failures are the "has been refunded" wording (the refund is issued but arrives in days) and occasional invented links — quality polish for a cheap model, not unsafe behaviour.

## How to reproduce

```bash
# .env needs OPENROUTER_API_KEY (and Postgres/Redis up for the stack suites)
pnpm eval:retrieval
pnpm evals:judge-calibrate
pnpm evals -- --judge
pnpm evals -- --models openai/gpt-5.6-luna,openai/gpt-5.4-mini,google/gemini-2.5-flash --judge
```
