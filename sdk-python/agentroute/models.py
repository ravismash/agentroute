"""Response models (mirrors @agentroute/contracts)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Effect = Literal["allow", "deny", "approval_required"]


@dataclass(frozen=True)
class DecisionReason:
    code: str
    message: str
    rule_id: str | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DecisionReason:
        return cls(code=str(d["code"]), message=str(d["message"]), rule_id=d.get("rule_id"))


@dataclass(frozen=True)
class Decision:
    """The gateway's answer to a proposal."""

    action_id: str
    effect: Effect
    state: str
    reasons: list[DecisionReason]
    policy: dict[str, str] | None
    result: Any = None
    #: False when this was an idempotent replay of an earlier request.
    created: bool = True

    @property
    def allowed(self) -> bool:
        return self.effect == "allow"

    @property
    def needs_approval(self) -> bool:
        return self.effect == "approval_required"

    @property
    def denied(self) -> bool:
        return self.effect == "deny"

    @property
    def completed(self) -> bool:
        return self.state == "succeeded"

    @classmethod
    def from_dict(cls, d: dict[str, Any], *, created: bool = True) -> Decision:
        return cls(
            action_id=str(d["action_id"]),
            effect=d["effect"],
            state=str(d["state"]),
            reasons=[DecisionReason.from_dict(r) for r in d.get("reasons", [])],
            policy=d.get("policy"),
            result=d.get("result"),
            created=created,
        )


@dataclass(frozen=True)
class ActionView:
    action_id: str
    case_id: str
    tool: str
    state: str
    effect: Effect
    reasons: list[DecisionReason]
    amount_minor: int | None
    currency: str | None
    created_at: str
    updated_at: str
    execution: dict[str, Any] | None = field(default=None)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ActionView:
        return cls(
            action_id=str(d["action_id"]),
            case_id=str(d["case_id"]),
            tool=str(d["tool"]),
            state=str(d["state"]),
            effect=d["effect"],
            reasons=[DecisionReason.from_dict(r) for r in d.get("reasons", [])],
            amount_minor=d.get("amount_minor"),
            currency=d.get("currency"),
            created_at=str(d["created_at"]),
            updated_at=str(d["updated_at"]),
            execution=d.get("execution"),
        )
