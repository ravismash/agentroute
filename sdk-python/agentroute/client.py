"""Dependency-free HTTP client for the AgentRoute gateway (standard library only)."""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from .errors import AgentRouteError, from_problem
from .models import ActionView, Decision

_TERMINAL_STATES = frozenset({"succeeded", "failed", "denied", "rejected", "expired", "cancelled"})


class AgentRoute:
    """Client for one tenant.

    Every proposal carries an idempotency key, so network errors and 5xx
    responses are retried safely: the gateway returns the original decision
    instead of creating a second action.

    >>> gw = AgentRoute("http://localhost:8080", api_key)
    >>> d = gw.propose("supportops", "case_1001", "create_refund_request",
    ...                {"customer_id": "cus_ada", "amount_minor": 1500,
    ...                 "currency": "USD", "reason_code": "duplicate_charge"})
    >>> d.effect, d.state
    ('allow', 'succeeded')
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 30.0,
        retries: int = 2,
        user_agent: str = "agentroute-python/0.1.0",
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._retries = retries
        self._user_agent = user_agent

    def propose(
        self,
        agent_id: str,
        case_id: str,
        tool: str,
        args: dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> Decision:
        """Submit a tool proposal and return the policy decision.

        Pass a stable ``idempotency_key`` (for example ``f"{run_id}:{tool_call_id}"``)
        so that retries of the same logical call can never create a second action.
        """
        key = idempotency_key or f"py-{uuid.uuid4()}"
        status, body = self._request(
            "POST",
            "/v1/proposals",
            {"agent_id": agent_id, "case_id": case_id, "tool": tool, "args": args},
            {"Idempotency-Key": key},
        )
        return Decision.from_dict(body, created=status == 201)

    def get_action(self, action_id: str) -> ActionView:
        _, body = self._request("GET", f"/v1/actions/{urllib.parse.quote(action_id, safe='')}")
        return ActionView.from_dict(body)

    def wait_for_action(self, action_id: str, *, timeout: float = 300.0, interval: float = 2.0) -> ActionView:
        """Poll until the action reaches a terminal state (e.g. after human approval)."""
        deadline = time.monotonic() + timeout
        while True:
            view = self.get_action(action_id)
            if view.state in _TERMINAL_STATES or time.monotonic() >= deadline:
                return view
            time.sleep(interval)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        data = json.dumps(body).encode() if body is not None else None
        all_headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": self._user_agent,
            **({"Content-Type": "application/json"} if data is not None else {}),
            **(headers or {}),
        }
        last: AgentRouteError | None = None
        for attempt in range(self._retries + 1):
            if attempt:
                time.sleep(min(2.0, 0.2 * 2**attempt) * random.uniform(0.5, 1.0))
            req = urllib.request.Request(self._base_url + path, data=data, headers=all_headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as res:  # noqa: S310 (URL is caller-configured)
                    return res.status, json.loads(res.read() or b"{}")
            except urllib.error.HTTPError as err:
                with err:  # close the underlying response; otherwise the socket leaks
                    raw = err.read()
                try:
                    problem = json.loads(raw or b"{}")
                except ValueError:
                    problem = {}
                last = from_problem(err.code, problem)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                last = AgentRouteError(0, "GATEWAY_UNREACHABLE", str(err))
            if not last.retryable:
                raise last
        assert last is not None
        raise last
