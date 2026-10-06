# AgentRoute Python SDK

A small, dependency-free client (standard library only, Python 3.10+) for the AgentRoute gateway. Use it to put any Python agent framework behind AgentRoute's policy checks.

```python
from agentroute import AgentRoute

gw = AgentRoute("http://localhost:8080", api_key)
decision = gw.propose(
    "supportops", "case_1001", "create_refund_request",
    {"customer_id": "cus_ada", "amount_minor": 1500, "currency": "USD", "reason_code": "duplicate_charge"},
    idempotency_key=f"{run_id}:{tool_call_id}",   # retries can never create a second action
)
if decision.denied:
    ...  # tell the model it isn't allowed; don't retry around it
elif decision.needs_approval:
    view = gw.wait_for_action(decision.action_id)  # or poll later
```

- Network errors, 429 and 5xx are retried with the **same** idempotency key, which is safe.
- Problem responses map to typed errors: `AuthError` (401), `NotFoundError` (404), `ConflictError` (409), `ValidationError` (400).

```bash
python -m unittest discover -s tests    # tests run against a local stub server
python examples/refund_agent.py          # needs the gateway running and `pnpm db:seed`
```
