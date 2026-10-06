# ADR-0006: Reply grounding, help-center retrieval and judged evals

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

The gateway stops wrong _actions_, but a model can still say wrong _things_: claim a refund that is only pending, invent a price or a timeline, or cite a help page that doesn't exist. Support agents also need policy knowledge they can't take from customer data, and reply quality has to be measured, not assumed.

## Decisions

### 1. Deterministic reply grounding as a policy rule

A new escalation type, `grounded_reply`, checks the reply text against **evidence**: the case's actions in the last 30 days and the current plan, which the gateway loads inside the decision transaction (`packages/policy-engine/src/grounding.ts`).

- Recognised claims: refund amounts with completion language ("refunded", "processed", "reembolsado"), amounts under review ("submitted", "pending approval"), plan changes, and "you're on the X plan".
- Ignored: questions, negations ("I can't refund…") and general policy statements ("refunds up to $25 are usually instant"). These were added after tests caught false positives on exactly those shapes.
- An ungrounded reply escalates to **human review** (`approval_required`) rather than being silently dropped. Missing evidence fails closed.

Why deterministic rather than another LLM: it's cheap, explainable (the reason names the unbacked claim), testable, and can't be talked out of its decision. It is deliberately conservative; the LLM judge covers semantics in evals.

### 2. Help-center retrieval (RAG)

`packages/knowledge`: 30 articles chunked by section, BM25 with domain synonyms, embeddings through any OpenAI-compatible endpoint (OpenRouter's `openai/text-embedding-3-small` by default) with a content-hash disk cache, and hybrid fusion with Reciprocal Rank Fusion (k = 60).

- **In-process, not Postgres.** At 75 chunks an in-memory index is faster and simpler. At scale the same `Retriever` interface maps to Postgres `tsvector` + `pgvector` (or a vector store). It wasn't done now because switching the Postgres image (alpine → pgvector/debian) on an existing data volume risks collation-related index corruption: a migration task in its own right.
- **Read locally by the agent.** Help content is public and has no side effects, so `search_help_center` doesn't go through the gateway. Customer data and every action still do.
- **Citations are checked:** evals fail a reply that links an article that doesn't exist or wasn't retrieved.

### 3. Retrieval evals with a held-out set

35 dev queries (used for tuning the stemmer and synonyms) plus 12 **held-out** queries written after tuning stopped and never used to tune. Reported metrics: recall@1/3/5 and MRR.

| BM25           | recall@1 | recall@5 | MRR  |
| -------------- | -------- | -------- | ---- |
| dev (tuned on) | 0.80     | 0.97     | 0.87 |
| held-out       | 0.58     | 0.75     | 0.65 |

The gap is the honest cost of lexical tuning: it overfits to known phrasings. Held-out misses are semantic ("a coworker needs access" vs "invite users"), which is the case for hybrid retrieval. `pnpm eval:retrieval` adds vector and hybrid rows when an embedding key is set. CI enforces regression floors on both sets.

### 4. LLM-as-judge, calibrated before trusted

The judge scores faithfulness, safety, tone and resolution (1–5, strict JSON, retried once on malformed output). It sees the actions with their real state and the retrieved article text. It defaults to a **different model family** (`anthropic/claude-sonnet-5`) from the agent (`openai/gpt-5.6-luna`) to reduce self-preference bias.

`pnpm evals:judge-calibrate` runs it on 24 hand-labelled replies (12 good, 12 with distinct failure types) and reports agreement and **Cohen's κ**. Judge scores are only trusted at κ ≥ 0.6.

### 5. Model comparison

`pnpm evals -- --models a,b,c --judge` runs the suite per model and reports pass rate, judge pass rate, policy saves, p50/p95 latency and **cost per case** from OpenRouter's live price list.

## Consequences

- Hallucinated claims about money and plans can't reach a customer unreviewed, and hallucinated citations fail evals.
- Grounding uses heuristics for English and some Spanish; unusual phrasings may slip through (false negatives are preferred to blocking good replies). Every miss found in production becomes a test case.
- Judge and model-comparison numbers need a live key; until then the README shows only offline results.
