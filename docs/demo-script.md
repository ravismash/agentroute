# AgentRoute — 3-minute demo script

A narrated walkthrough for a screen recording. Target length **~3 minutes**. It shows the one idea that matters: **the agent proposes, a deterministic policy decides**, and money actions execute exactly once.

**Setup before recording**

- Base URL: `https://agentroute-gateway.onrender.com` (free tier — hit `/healthz` once first so it's warm; cold start ~30 s).
- Credentials come from the Render deploy (printed once when `SEED_ON_START=true`): a tenant **API key** and an **operator token**.
- Two terminals + a browser tab on the approval dashboard `…/ui/`.
- Export these so the commands below are copy-paste:
  ```bash
  export BASE=https://agentroute-gateway.onrender.com
  export API_KEY=<tenant api key from the deploy logs>
  ```
- Seeded world: tenant **acme**, customer **cus_ada** on case **case_1001**, customer **cus_grace** on **case_1002**, a $500 test payment per customer.

---

## [0:00–0:20] Hook

> "This is AgentRoute. It lets an AI support agent issue refunds and change plans — but the AI never makes the final decision. It _proposes_ an action; a deterministic policy layer decides allow, needs-approval, or deny. Every call is logged. Let me show you four proposals and what the gateway does with each."

_(On screen: the README title + the live dashboard at `…/ui/`.)_

---

## [0:20–1:00] Scenario 1 — small refund, auto-allowed

> "A $15 refund for the right customer, valid reason. Policy auto-allows refunds up to $25, so this executes immediately — one Stripe test refund, exactly once."

```bash
curl -s -X POST $BASE/v1/proposals \
  -H "authorization: Bearer $API_KEY" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"agent_id":"supportops","case_id":"case_1001","tool":"create_refund_request",
       "args":{"customer_id":"cus_ada","amount_minor":1500,"currency":"USD","reason_code":"duplicate_charge"}}' | jq
```

> _Point at the response:_ "`effect: allow`, the action goes straight to executed, and the decision records the policy version and the rule that allowed it."

---

## [1:00–1:50] Scenario 2 — large refund, human in the loop

> "Now $299. Over the $25 auto-limit, so policy escalates to approval_required — it does **not** execute yet."

```bash
curl -s -X POST $BASE/v1/proposals \
  -H "authorization: Bearer $API_KEY" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"agent_id":"supportops","case_id":"case_1001","tool":"create_refund_request",
       "args":{"customer_id":"cus_ada","amount_minor":29900,"currency":"USD","reason_code":"service_outage"}}' | jq
```

> _Switch to the dashboard:_ "The pending approval shows the exact proposal and the policy reason. I log in as an operator and approve it."

_(Click Approve in `…/ui/`.)_

> "The gateway executes the **stored** proposal — the exact amount I just reviewed. The model is never re-asked, so it can't change the parameters after approval. And if I double-click approve, the second one returns 409 — exactly one refund."

---

## [1:50–2:30] Scenario 3 — prompt injection, denied

> "Here's the attack this is built for. The message tries to redirect the refund to a _different_ customer — cus_grace — on Ada's case. The gateway checks the customer against the case's real data, not the model's claim."

```bash
curl -s -X POST $BASE/v1/proposals \
  -H "authorization: Bearer $API_KEY" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"agent_id":"supportops","case_id":"case_1001","tool":"create_refund_request",
       "args":{"customer_id":"cus_grace","amount_minor":1500,"currency":"USD","reason_code":"duplicate_charge"}}' | jq
```

> "`deny`, code `POLICY_CONTEXT_MISMATCH`. No execution, and the denial is audited. The prompt can say whatever it wants — the arguments are bound to server-side truth."

---

## [2:30–2:50] Scenario 4 — blocked tool

> "And some tools the agent simply can't call. Exporting customer data is on the blocklist — default-deny, no matter the arguments."

```bash
curl -s -X POST $BASE/v1/proposals \
  -H "authorization: Bearer $API_KEY" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"agent_id":"supportops","case_id":"case_1001","tool":"export_customer_data",
       "args":{"customer_id":"cus_ada"}}' | jq
```

> "`deny`, `POLICY_TOOL_NOT_ALLOWED`."

---

## [2:50–3:00] Close

> "Four proposals: one allowed, one sent to a human, two blocked — all decided by versioned rules, not the model, and all audited. It's open source and live. Link below."

_(On screen: repo URL + live demo URL.)_

---

### Backup scenario (if you want a 5th / to swap one out)

**Split-refund abuse → approval_required.** Two $20 refunds on the same case: the first auto-allows, the second trips the 30-day case aggregate (> $25 total) and escalates — showing the agent can't split one large refund into small ones to dodge the limit.
