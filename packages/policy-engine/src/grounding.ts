/**
 * Deterministic reply grounding: claims a reply makes about refunds and plans
 * must be backed by actions that actually happened on the case.
 *
 * Evidence-first and conservative: it checks the claims it can recognise
 * (money amounts with "done" or "under review" language, plan changes, the
 * current plan) and ignores sentences it doesn't understand. It is a safety
 * net, not a full semantic check; the LLM judge covers semantics in evals.
 */

export interface EvidenceAction {
  tool: string;
  state: string;
  amount_minor: number | null;
  currency: string | null;
  target_plan: string | null;
}

export interface GroundingEvidence {
  /** Actions on this case (excluding replies), newest last. */
  actions: EvidenceAction[];
  current_plan: string | null;
}

export interface GroundingFinding {
  claim: string;
  problem: string;
}

export interface GroundingResult {
  grounded: boolean;
  findings: GroundingFinding[];
}

const NEGATION =
  /\b(not|no|never|unable|cannot|can't|can not|won't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|no puedo|no podemos)\b/i;
const DONE =
  /\b(refunded|reimbursed|credited|issued|processed|returned|sent (?:it |you |the money )?back|reembols(?:ado|ada|amos)|devuelto|devolvimos)\b/i;
const PENDING =
  /\b(review|reviewing|reviewed|submitted|pending|approval|approve|flagged|escalat\w*|forwarded|passed (?:it|your|this|the)|with our team|will confirm|in progress|revisi[oó]n|pendiente)\b/i;
/** General statements ("refunds up to $25 are usually instant") describe policy, not this customer. */
const GENERIC =
  /\b(up to|above|over|more than|less than|under|at least|usually|typically|generally|normally|any|all|hasta|normalmente)\b/i;
/** A claim about this customer: personal reference or completed tense. */
const ABOUT_CUSTOMER =
  /\b(you|your|yours|i|i've|i have|we|we've|we have|has been|have been|was|were|le|les|su|sus|hemos|ha sido|han sido)\b/i;
const REFUND_TOPIC =
  /\b(refund\w*|reembols\w*|devoluci[oó]n|devolv\w*|credit\w*|money back|charge\w*|cargo\w*)\b/i;
const MONEY =
  /(?:US\$|\$|USD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d+)(?:[.,](\d{2}))?\s?(?:dollars?|d[oó]lares|usd)\b/gi;
const PLANS = "(starter|pro|business)";
const PLAN_CHANGE = new RegExp(
  `\\b(?:moved?|switch(?:ed)?|upgraded?|downgraded?|changed?)\\b[^.;!?]*?\\bto\\s+(?:the\\s+)?${PLANS}\\b`,
  "i",
);
const PLAN_STATE = new RegExp(
  `\\byou(?:'re|’re| are)\\s+(?:now\\s+|currently\\s+)?on\\s+(?:the\\s+)?${PLANS}\\b`,
  "i",
);

const REFUND_TOOL = "create_refund_request";
const PLAN_TOOL = "change_subscription_plan";
const NOT_REQUESTED = new Set(["denied", "rejected", "expired", "cancelled"]);

/** Split into clauses so "refunded $20; the other $20 is under review" is judged per claim. */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+|,\s+(?=but\b)|\s+but\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function moneyIn(clause: string): number[] {
  const amounts: number[] = [];
  for (const m of clause.matchAll(MONEY)) {
    const whole = (m[1] ?? m[3] ?? "").replaceAll(",", "");
    const cents = (m[2] ?? m[4] ?? "0").padEnd(2, "0");
    if (whole) amounts.push(Number(whole) * 100 + Number(cents));
  }
  return amounts;
}

function formatMinor(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export function checkGrounding(text: string, evidence: GroundingEvidence): GroundingResult {
  const findings: GroundingFinding[] = [];
  const refunds = evidence.actions.filter((a) => a.tool === REFUND_TOOL);
  const completed = refunds.filter((a) => a.state === "succeeded").map((a) => a.amount_minor ?? 0);
  const requested = refunds.filter((a) => !NOT_REQUESTED.has(a.state)).map((a) => a.amount_minor ?? 0);
  const completedTotal = completed.reduce((s, n) => s + n, 0);
  const plansChanged = evidence.actions
    .filter((a) => a.tool === PLAN_TOOL && a.state === "succeeded" && a.target_plan)
    .map((a) => a.target_plan?.toLowerCase());
  const plansRequested = evidence.actions
    .filter((a) => a.tool === PLAN_TOOL && !NOT_REQUESTED.has(a.state) && a.target_plan)
    .map((a) => a.target_plan?.toLowerCase());

  for (const clause of clauses(text)) {
    // Questions, negations and general policy statements make no claim about this case.
    if (clause.endsWith("?") || NEGATION.test(clause) || GENERIC.test(clause)) continue;
    const amounts = moneyIn(clause);
    const pending = PENDING.test(clause);
    const done = DONE.test(clause) && !pending && ABOUT_CUSTOMER.test(clause);

    // Refund claims.
    if ((done || pending) && (amounts.length > 0 || REFUND_TOPIC.test(clause))) {
      if (done) {
        if (amounts.length === 0 && completed.length === 0) {
          findings.push({ claim: clause, problem: "claims a refund was completed, but none was" });
        }
        for (const amount of amounts) {
          if (!completed.includes(amount) && amount !== completedTotal) {
            findings.push({
              claim: clause,
              problem: `claims ${formatMinor(amount)} was refunded, but no completed refund matches`,
            });
          }
        }
      } else {
        for (const amount of amounts) {
          if (!requested.includes(amount)) {
            findings.push({
              claim: clause,
              problem: `says ${formatMinor(amount)} is under review, but no such refund was requested`,
            });
          }
        }
      }
    }

    // Plan claims.
    const change = PLAN_CHANGE.exec(clause);
    if (change?.[1]) {
      const plan = change[1].toLowerCase();
      const backing = pending ? plansRequested : plansChanged;
      if (!backing.includes(plan)) {
        findings.push({
          claim: clause,
          problem: `claims a change to the ${plan} plan that ${pending ? "was not requested" : "did not happen"}`,
        });
      }
    }
    const state = PLAN_STATE.exec(clause);
    if (state?.[1]) {
      const plan = state[1].toLowerCase();
      if (plan !== evidence.current_plan?.toLowerCase() && !plansChanged.includes(plan)) {
        findings.push({
          claim: clause,
          problem: `says the customer is on the ${plan} plan, which does not match their subscription`,
        });
      }
    }
  }
  return { grounded: findings.length === 0, findings };
}
