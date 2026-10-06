"""Minimal framework-agnostic agent loop using the AgentRoute Python SDK.

Shows the integration pattern for *any* agent framework (LangGraph, CrewAI,
your own loop): wherever the agent would call a tool directly, it proposes
the call to AgentRoute and acts on the decision.

    cd sdk-python
    python examples/refund_agent.py            # reads ../.dev-credentials.json from `pnpm db:seed`
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from agentroute import AgentRoute, AgentRouteError  # noqa: E402

CREDENTIALS = pathlib.Path(__file__).resolve().parents[2] / ".dev-credentials.json"


def handle_tool_call(gw: AgentRoute, run_id: str, call_id: str, tool: str, args: dict) -> str:
    """What your framework's tool executor does: propose, then report the outcome to the model."""
    try:
        decision = gw.propose("supportops", "case_1001", tool, args, idempotency_key=f"{run_id}:{call_id}")
    except AgentRouteError as err:
        return f"error ({err.code}); tell the customer a specialist will follow up"
    if decision.denied:
        return "denied: " + "; ".join(r.message for r in decision.reasons)
    if decision.needs_approval:
        return f"pending human approval (action {decision.action_id})"
    return f"done ({decision.state})" + (f": {json.dumps(decision.result)}" if decision.result else "")


def main() -> None:
    api_key = os.environ.get("AGENTROUTE_API_KEY") or json.loads(CREDENTIALS.read_text())["api_key"]
    gw = AgentRoute(os.environ.get("AGENTROUTE_URL", "http://localhost:8080"), api_key)
    run_id = str(uuid.uuid4())

    # Pretend these tool calls came from an LLM.
    calls = [
        ("call_1", "get_customer", {"customer_id": "cus_ada"}),
        ("call_2", "create_refund_request",
         {"customer_id": "cus_ada", "amount_minor": 800, "currency": "USD", "reason_code": "duplicate_charge"}),
        ("call_3", "create_refund_request",  # a prompt-injected attempt: another customer's refund
         {"customer_id": "cus_grace", "amount_minor": 800, "currency": "USD", "reason_code": "goodwill"}),
    ]
    for call_id, tool, args in calls:
        print(f"{tool:24s} → {handle_tool_call(gw, run_id, call_id, tool, args)}")


if __name__ == "__main__":
    main()
