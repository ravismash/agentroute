"""Typed errors mapped from the gateway's RFC 7807 problem responses."""

from __future__ import annotations

from typing import Any


class AgentRouteError(Exception):
    """Base error. ``status`` is 0 when the gateway could not be reached."""

    def __init__(self, status: int, code: str, detail: str, problem: dict[str, Any] | None = None) -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.status = status
        self.code = code
        self.detail = detail
        self.problem = problem or {}

    @property
    def retryable(self) -> bool:
        """True for errors worth retrying with the same idempotency key."""
        return self.status == 0 or self.status == 429 or self.status >= 500


class AuthError(AgentRouteError):
    """401: missing, invalid or revoked API key."""


class NotFoundError(AgentRouteError):
    """404: unknown case or action (or one belonging to another tenant)."""


class ConflictError(AgentRouteError):
    """409: idempotency key reused with a different request, or invalid state transition."""


class ValidationError(AgentRouteError):
    """400: the request did not match the API contract."""


_BY_STATUS: dict[int, type[AgentRouteError]] = {
    400: ValidationError,
    401: AuthError,
    404: NotFoundError,
    409: ConflictError,
}


def from_problem(status: int, problem: dict[str, Any] | None) -> AgentRouteError:
    problem = problem or {}
    cls = _BY_STATUS.get(status, AgentRouteError)
    return cls(
        status,
        str(problem.get("code", "HTTP_ERROR")),
        str(problem.get("detail") or problem.get("title") or f"HTTP {status}"),
        problem,
    )
