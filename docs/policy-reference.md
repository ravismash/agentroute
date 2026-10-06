# Policy reference (`agentroute/v1`)

Policies decide what an agent's proposed action may do. They are YAML files, validated when loaded: an invalid policy is rejected and the previously active version stays in force.

Example: [`policies/support-agent-baseline.v1.yaml`](../policies/support-agent-baseline.v1.yaml).

## How a proposal is decided

Checks run in this order. The first four stop at the first failure.

| Step | Check                                                      | Result if it fails                                          |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | Policy applies to this tenant and agent                    | `deny` · `POLICY_DEFAULT_DENY`                              |
| 2    | Tool is not in `blocked_tools`                             | `deny` · `POLICY_TOOL_NOT_ALLOWED`                          |
| 3    | Tool is listed under `tools`                               | `deny` · `POLICY_DEFAULT_DENY`                              |
| 4    | Arguments match the tool's schema                          | `deny` · `POLICY_PARAM_INVALID`                             |
| 5    | Every `require` rule passes (all are checked and reported) | `deny` · `POLICY_CONTEXT_MISMATCH` / `POLICY_PARAM_INVALID` |
| 6    | Each `escalate` rule that triggers raises the effect       | `approval_required` or `deny`                               |

The final effect is the most severe of the tool's base `effect` and any triggered escalations: **deny > approval_required > allow**.

If anything goes wrong during evaluation (for example, missing usage data), the decision is `deny` with `POLICY_EVALUATION_ERROR`. The engine **fails closed**.

## Document fields

```yaml
apiVersion: agentroute/v1 # required, exact value
id: support-agent-baseline # lowercase kebab-case
version: 1.0.0 # semver; recorded with every decision
tenant: "*" # "*" = all tenants; a tenant id overrides "*" for that tenant
agents: [supportops] # agent ids this policy governs
default: deny # required; only "deny" is allowed
blocked_tools: [delete_account]
tools:
  <tool_name>: # must be a tool defined in @agentroute/contracts
    effect: allow # allow | approval_required (use blocked_tools to deny)
    require: [...]
    escalate: [...]
```

## Requirement rules (`require`)

Any failing requirement denies the proposal.

**`context_equals`**: a tool argument must equal a value from server-side context, never from the LLM.

```yaml
- id: customer-matches-case
  type: context_equals
  arg: customer_id
  field: case.customer_id # roots: tenant_id, agent_id, case, customer, subscription
```

If the context field is missing, the rule fails.

**`arg_in`**: an argument must be one of the listed values.

```yaml
- id: known-plan
  type: arg_in
  arg: target_plan
  values: [starter, pro, business]
```

## Escalation rules (`escalate`)

**`threshold`**: triggers when a numeric argument is greater than `gt`.

```yaml
- id: refund-over-auto-limit
  type: threshold
  arg: amount_minor # integer minor units: 2500 = $25.00
  gt: 2500
  effect: approval_required # approval_required | deny
```

**`aggregate`**: triggers when _existing usage plus this proposal_ is greater than `gt` within a time window. This catches split refunds and repeated actions.

```yaml
- id: case-refund-total
  type: aggregate
  metric: refund_amount_minor # refund_amount_minor | refund_count | plan_change_count
  scope: case # case | customer | tenant
  window: 30d # Nm | Nh | Nd
  gt: 2500
  effect: approval_required
```

The gateway reads the required usage (`planUsage()`) inside the decision transaction, so two concurrent proposals cannot both slip under a limit.

## Testing a policy change

- `loadPolicy(yaml)` validates a policy without activating it.
- `dryRun(policy, cases)` shows what a policy would decide for a set of proposals.
- `comparePolicies(current, candidate, cases)` lists every case whose decision would change. **Loosened** cases (for example, approval → allow) should be reviewed before activation.

## Decision output

```json
{
  "effect": "approval_required",
  "reasons": [
    {
      "code": "POLICY_THRESHOLD_EXCEEDED",
      "message": "amount_minor 29900 exceeds 2500",
      "rule_id": "create_refund_request/refund-over-auto-limit"
    }
  ],
  "matched_rules": ["create_refund_request/base", "create_refund_request/refund-over-auto-limit"],
  "policy": {
    "id": "support-agent-baseline",
    "version": "1.0.0",
    "checksum": "<sha256 of the policy source>"
  }
}
```
