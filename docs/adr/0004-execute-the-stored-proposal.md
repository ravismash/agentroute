# ADR-0004: Execute the stored proposal; never re-ask the LLM after approval

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

When an action needs human approval, the agent's run pauses. After approval, something has to perform the action. One option is to resume the agent and let the model call the tool again. But the model is non-deterministic and may have been manipulated by prompt injection. If it re-generates the call, the executed refund could differ from the one the human approved: a different amount, a different customer.

## Decision

- The gateway executes the **stored, policy-checked proposal**. The model is never asked to regenerate an approved action.
- A database trigger makes an action's business fields (tool, args, amount, currency, customer, case) **immutable** after insert, so even a bug can't change what was approved.
- The agent is resumed only to tell the customer what happened, for example to draft a reply. That is a separate proposal that goes through the policy again.

## Consequences

- The approver sees exactly what will run, and an audit can prove it.
- Agents must treat write tools as asynchronous: a proposal may come back `approval_required`, and the outcome arrives later (`GET /v1/actions/:id`, and SSE in Phase 3).
- If the situation changes while an approval is pending, the operator rejects it and the agent proposes again, rather than the approved action being edited.
