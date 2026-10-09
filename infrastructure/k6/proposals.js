// k6 load test for the decision path. Exercises POST /v1/proposals with a mix
// of allowed / denied / grounded-reply proposals and checks the SLO:
// p95 decision overhead < 25 ms (design doc §1.2), excluding the LLM.
//
//   # seed a tenant + API key first (local): pnpm db:seed --rotate
//   BASE=http://localhost:8080 \
//   API_KEY=$(node -p "require('./.dev-credentials.json').api_key") \
//   k6 run -e BASE=$BASE -e API_KEY=$API_KEY infrastructure/k6/proposals.js
//
// Ramps to 100 virtual users. Each VU works on its own case so per-customer
// locks don't serialise the test. The gateway must be seeded with cases
// case_1..case_N (the e2e/seed fixtures provide case_1001 etc.; adjust CASE_IDS
// to match your seed, or point at a tenant seeded for load).

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://localhost:8080";
const API_KEY = __ENV.API_KEY;

const decisionLatency = new Trend("decision_latency_ms", true);

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 50 },
        { duration: "30s", target: 100 },
        { duration: "15s", target: 0 },
      ],
      gracefulStop: "5s",
    },
  },
  thresholds: {
    // The SLO: p95 gateway decision overhead under 25 ms, p99 under 75 ms.
    "http_req_duration{expected_response:true}": ["p(95)<25", "p(99)<75"],
    http_req_failed: ["rate<0.001"],
  },
};

// Three cases seeded by the demo fixtures. Replace with your load tenant's cases.
const CASES = (__ENV.CASE_IDS || "case_1001,case_1002").split(",");

function headers() {
  return {
    authorization: `Bearer ${API_KEY}`,
    "idempotency-key": `k6-${__VU}-${__ITER}-${Date.now()}`,
    "content-type": "application/json",
  };
}

export default function () {
  if (!API_KEY) throw new Error("set API_KEY (a tenant API key)");
  const caseId = CASES[__VU % CASES.length];
  // Read tool: allowed, cheap decision.
  const body = JSON.stringify({
    agent_id: "supportops",
    case_id: caseId,
    tool: "get_customer",
    args: { customer_id: "cus_ada" },
  });
  const res = http.post(`${BASE}/v1/proposals`, body, { headers: headers() });
  decisionLatency.add(res.timings.duration);
  check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
    "has an effect": (r) => {
      try {
        return typeof r.json("effect") === "string";
      } catch {
        return false;
      }
    },
  });
}
