"""Tests against a local stub gateway (standard library only: python -m unittest)."""

from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

from agentroute import AgentRoute, AgentRouteError, AuthError, ConflictError, NotFoundError

DECISION = {
    "action_id": "01a10fe0-0000-7000-8000-000000000001",
    "effect": "approval_required",
    "state": "approval_required",
    "reasons": [{"code": "POLICY_THRESHOLD_EXCEEDED", "message": "too big", "rule_id": "r/1"}],
    "policy": {"id": "support-agent-baseline", "version": "1.0.0"},
}
ACTION = {
    "action_id": DECISION["action_id"],
    "case_id": "case_1",
    "tool": "create_refund_request",
    "state": "succeeded",
    "effect": "approval_required",
    "reasons": DECISION["reasons"],
    "amount_minor": 29900,
    "currency": "USD",
    "created_at": "2026-10-06T00:00:00.000Z",
    "updated_at": "2026-10-06T00:01:00.000Z",
    "execution": {"status": "succeeded", "attempt": 1, "provider_ref": "re_1", "error_code": None},
}


class StubGateway(BaseHTTPRequestHandler):
    # Scripted responses: list of (status, body). Requests are recorded.
    responses: ClassVar[list[tuple[int, dict[str, Any]]]] = []
    requests: ClassVar[list[dict[str, Any]]] = []

    def _respond(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        StubGateway.requests.append(
            {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
        )
        status, payload = StubGateway.responses.pop(0)
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _respond
    do_POST = _respond

    def log_message(self, *_: Any) -> None:  # silence test output
        pass


def problem(status: int, code: str) -> tuple[int, dict[str, Any]]:
    return status, {"type": "about:blank", "title": code, "status": status, "code": code, "detail": code.lower()}


class ClientTest(unittest.TestCase):
    server: ClassVar[ThreadingHTTPServer]

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StubGateway)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        StubGateway.responses = []
        StubGateway.requests = []
        host, port = self.server.server_address[:2]
        self.client = AgentRoute(f"http://{host}:{port}", "ar_test_key", retries=2)

    def test_propose_sends_auth_and_idempotency_key(self) -> None:
        StubGateway.responses = [(201, DECISION)]
        d = self.client.propose("supportops", "case_1", "create_refund_request", {"amount_minor": 29900},
                                idempotency_key="run-1:call-1")
        self.assertTrue(d.needs_approval)
        self.assertTrue(d.created)
        self.assertEqual(d.reasons[0].rule_id, "r/1")
        req = StubGateway.requests[0]
        self.assertEqual(req["path"], "/v1/proposals")
        self.assertEqual(req["headers"]["Authorization"], "Bearer ar_test_key")
        self.assertEqual(req["headers"]["Idempotency-Key"], "run-1:call-1")
        self.assertEqual(req["body"]["tool"], "create_refund_request")

    def test_replay_is_reported(self) -> None:
        StubGateway.responses = [(200, DECISION)]
        d = self.client.propose("supportops", "case_1", "get_customer", {}, idempotency_key="k-123456")
        self.assertFalse(d.created)

    def test_retries_5xx_with_the_same_idempotency_key(self) -> None:
        StubGateway.responses = [problem(503, "INTERNAL"), (201, DECISION)]
        self.client.propose("supportops", "case_1", "get_customer", {}, idempotency_key="same-key-1")
        keys = {r["headers"]["Idempotency-Key"] for r in StubGateway.requests}
        self.assertEqual(len(StubGateway.requests), 2)
        self.assertEqual(keys, {"same-key-1"})

    def test_generates_an_idempotency_key_when_omitted(self) -> None:
        StubGateway.responses = [(201, DECISION)]
        self.client.propose("supportops", "case_1", "get_customer", {})
        self.assertTrue(StubGateway.requests[0]["headers"]["Idempotency-Key"].startswith("py-"))

    def test_maps_problem_responses_to_typed_errors(self) -> None:
        for status, code, cls in [
            (401, "AUTH_INVALID_KEY", AuthError),
            (404, "NOT_FOUND", NotFoundError),
            (409, "IDEMPOTENCY_CONFLICT", ConflictError),
        ]:
            StubGateway.responses = [problem(status, code)]
            with self.assertRaises(cls) as ctx:
                self.client.propose("supportops", "case_1", "get_customer", {}, idempotency_key="k-123456")
            self.assertEqual(ctx.exception.code, code)
            self.assertFalse(ctx.exception.retryable)

    def test_does_not_retry_client_errors(self) -> None:
        StubGateway.responses = [problem(409, "IDEMPOTENCY_CONFLICT")]
        with self.assertRaises(ConflictError):
            self.client.propose("supportops", "case_1", "get_customer", {}, idempotency_key="k-123456")
        self.assertEqual(len(StubGateway.requests), 1)

    def test_get_and_wait_for_action(self) -> None:
        pending = {**ACTION, "state": "approval_required", "execution": None}
        StubGateway.responses = [(200, pending), (200, ACTION)]
        view = self.client.wait_for_action(ACTION["action_id"], interval=0.01)
        self.assertEqual(view.state, "succeeded")
        self.assertEqual(view.execution["provider_ref"], "re_1")

    def test_unreachable_gateway(self) -> None:
        client = AgentRoute("http://127.0.0.1:9", "k", retries=0, timeout=1)
        with self.assertRaises(AgentRouteError) as ctx:
            client.propose("supportops", "case_1", "get_customer", {})
        self.assertEqual(ctx.exception.status, 0)
        self.assertTrue(ctx.exception.retryable)


if __name__ == "__main__":
    unittest.main()
