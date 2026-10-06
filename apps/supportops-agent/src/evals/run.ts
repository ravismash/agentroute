/**
 * Agent evals.
 *
 *   pnpm evals                                  # live model from .env (needs an LLM key)
 *   pnpm evals -- --scripted                    # offline: scripted model, BM25 retrieval
 *   pnpm evals -- --only injection              # filter by scenario id or category
 *   pnpm evals -- --judge                       # add LLM-as-judge scores
 *   pnpm evals -- --models a,b,c                # compare OpenRouter models (pass rate, cost, latency)
 *
 * Scenarios run against the in-process gateway (real policy, no side effects).
 * Results are written to evals/results/<timestamp>.json (git-ignored).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRetriever, embeddingsFromEnv } from "@agentroute/knowledge";
import { loadConfig, type LlmConfig } from "../config.js";
import { createModel, ScriptedModel } from "../model.js";
import { judge, judgeFromEnv, type JudgeVerdict } from "./judge.js";
import { SCENARIOS } from "./scenarios.js";
import { runScenario, type ScenarioResult } from "./score.js";
import { costUsd, fetchOpenRouterPricing, mean, percentile, type ModelPricing } from "./stats.js";

const RESULTS_DIR = fileURLToPath(new URL("../../evals/results/", import.meta.url));
const EMBEDDINGS_CACHE = fileURLToPath(new URL("../../../../.cache/embeddings.json", import.meta.url));
const PASS_THRESHOLD = 0.9;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const scripted = flag("scripted");
const only = option("only");
const modelsArg = option("models");
if (!scripted && !config.llm) {
  console.error("No LLM configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY) in .env, or pass --scripted.");
  process.exit(2);
}
const llm = config.llm;
const judgeConfig = flag("judge") && !scripted ? judgeFromEnv(process.env) : undefined;
if (flag("judge") && !judgeConfig) console.warn("--judge needs OPENROUTER_API_KEY and a live run; skipping.");

// Scripted runs use BM25 (deterministic, offline); live runs use hybrid retrieval when a key is set.
const knowledge = createRetriever(scripted ? undefined : embeddingsFromEnv(process.env, EMBEDDINGS_CACHE));
const scenarios = SCENARIOS.filter((s) => !only || s.id.includes(only) || s.category === only);

interface Row extends ScenarioResult {
  latency_ms: number;
  judge?: JudgeVerdict | { error: string };
}

interface ModelRun {
  model: string;
  rows: Row[];
  pass_rate: number;
  judge_pass_rate: number | null;
  policy_saves: number;
  p50_ms: number;
  p95_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_per_case_usd: number;
}

function errorRow(id: string, message: string, latency_ms: number): Row {
  const scenario = SCENARIOS.find((s) => s.id === id);
  return {
    id,
    title: scenario?.title ?? id,
    category: scenario?.category ?? "robustness",
    passed: false,
    failures: [`error: ${message}`],
    policySaves: 0,
    actions: [],
    sources: [],
    reply: "",
    usage: { requests: 0, input_tokens: 0, output_tokens: 0 },
    latency_ms,
  };
}

async function runSuite(model: string, llmConfig: LlmConfig | undefined): Promise<ModelRun> {
  console.log(`\n▶ ${model} · ${scenarios.length} scenarios · retrieval ${knowledge.name}`);
  const rows: Row[] = [];
  for (const scenario of scenarios) {
    const factory = llmConfig ? () => createModel(llmConfig) : () => new ScriptedModel(scenario.script);
    const started = performance.now();
    let row: Row;
    try {
      const result = await runScenario(scenario, factory, { maxTurns: config.AGENT_MAX_TURNS, knowledge });
      row = { ...result, latency_ms: Math.round(performance.now() - started) };
      if (judgeConfig) {
        row.judge = await judge(judgeConfig.client, {
          message: scenario.message,
          actions: result.actions,
          sources: result.sources,
          reply: result.reply,
        }).catch((err: unknown) => ({ error: (err as Error).message }));
      }
    } catch (err) {
      row = errorRow(scenario.id, (err as Error).message, Math.round(performance.now() - started));
    }
    rows.push(row);
    const judged = row.judge && "scores" in row.judge ? ` judge=${row.judge.pass ? "pass" : "fail"}` : "";
    console.log(`${row.passed ? "PASS" : "FAIL"}  ${row.id.padEnd(30)}${judged} ${row.failures.join("; ")}`);
  }
  const latencies = rows.map((r) => r.latency_ms);
  const judged = rows.flatMap((r) => (r.judge && "scores" in r.judge ? [r.judge.pass ? 1 : 0] : []));
  return {
    model,
    rows,
    pass_rate: mean(rows.map((r) => (r.passed ? 1 : 0))),
    judge_pass_rate: judged.length ? mean(judged) : null,
    policy_saves: rows.reduce((n, r) => n + r.policySaves, 0),
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    input_tokens: rows.reduce((n, r) => n + r.usage.input_tokens, 0),
    output_tokens: rows.reduce((n, r) => n + r.usage.output_tokens, 0),
    cost_per_case_usd: Number.NaN,
  };
}

const runs: ModelRun[] = [];
if (scripted || !llm) {
  runs.push(await runSuite("scripted", undefined));
} else {
  const models = modelsArg
    ? modelsArg
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : [llm.model];
  let pricing = new Map<string, ModelPricing>();
  if (llm.provider === "openrouter") pricing = await fetchOpenRouterPricing().catch(() => pricing);
  for (const model of models) {
    const run = await runSuite(model, { ...llm, model });
    run.cost_per_case_usd =
      costUsd({ input_tokens: run.input_tokens, output_tokens: run.output_tokens }, pricing.get(model)) /
      Math.max(1, run.rows.length);
    runs.push(run);
  }
}

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
console.log("\n| model | pass | judge pass | policy saves | p50 | p95 | tokens in/out | cost per case |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const cost = Number.isNaN(r.cost_per_case_usd) ? "—" : `$${r.cost_per_case_usd.toFixed(4)}`;
  console.log(
    `| ${r.model} | ${pct(r.pass_rate)} | ${pct(r.judge_pass_rate)} | ${r.policy_saves} | ${(r.p50_ms / 1000).toFixed(1)}s | ` +
      `${(r.p95_ms / 1000).toFixed(1)}s | ${r.input_tokens}/${r.output_tokens} | ${cost} |`,
  );
}

await mkdir(RESULTS_DIR, { recursive: true });
const file = `${RESULTS_DIR}${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(
  file,
  JSON.stringify({ retrieval: knowledge.name, judge: judgeConfig?.model ?? null, runs }, null, 2),
);
console.log(`\nresults: ${file}`);
process.exitCode = runs.every((r) => r.pass_rate >= PASS_THRESHOLD) ? 0 : 1;
