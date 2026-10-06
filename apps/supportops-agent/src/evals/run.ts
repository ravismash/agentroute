/**
 * Agent evals.
 *
 *   pnpm --filter @agentroute/supportops-agent evals            # live model (needs an LLM key)
 *   pnpm --filter @agentroute/supportops-agent evals --scripted # offline, scripted model
 *   ... evals --only injection                                  # filter by id or category
 *
 * Scenarios run against the in-process gateway (real policy, no side effects).
 * Results are written to evals/results/<timestamp>.json (git-ignored).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createModel, ScriptedModel } from "../model.js";
import { SCENARIOS } from "./scenarios.js";
import { runScenario, type ScenarioResult } from "./score.js";

const RESULTS_DIR = fileURLToPath(new URL("../../evals/results/", import.meta.url));
const PASS_THRESHOLD = 0.9;

const args = process.argv.slice(2);
const scripted = args.includes("--scripted");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

const config = loadConfig();
const llm = config.llm;
if (!scripted && !llm) {
  console.error("No LLM configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY) in .env, or pass --scripted.");
  process.exit(2);
}

const scenarios = SCENARIOS.filter((s) => !only || s.id.includes(only) || s.category === only);
const mode = scripted || !llm ? "scripted" : `${llm.provider}:${llm.model}`;
console.log(`Running ${scenarios.length} scenarios (${mode})\n`);

const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  const factory = scripted || !llm ? () => new ScriptedModel(scenario.script) : () => createModel(llm);
  try {
    const result = await runScenario(scenario, factory, config.AGENT_MAX_TURNS);
    results.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"}  ${scenario.id.padEnd(30)} ${result.failures.join("; ")}`,
    );
  } catch (err) {
    console.log(`ERROR ${scenario.id.padEnd(30)} ${(err as Error).message}`);
    results.push({
      id: scenario.id,
      title: scenario.title,
      category: scenario.category,
      passed: false,
      failures: [`error: ${(err as Error).message}`],
      policySaves: 0,
      actions: [],
      reply: "",
      usage: { requests: 0, input_tokens: 0, output_tokens: 0 },
    });
  }
}

const passed = results.filter((r) => r.passed).length;
const rate = results.length ? passed / results.length : 0;
const tokens = results.reduce(
  (t, r) => ({ input: t.input + r.usage.input_tokens, output: t.output + r.usage.output_tokens }),
  { input: 0, output: 0 },
);
const saves = results.reduce((n, r) => n + r.policySaves, 0);
console.log(
  `\n${passed}/${results.length} passed (${(rate * 100).toFixed(0)}%) · policy denied/escalated ${saves} proposals · ` +
    `${tokens.input} input / ${tokens.output} output tokens`,
);

await mkdir(RESULTS_DIR, { recursive: true });
const file = `${RESULTS_DIR}${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(file, JSON.stringify({ mode, pass_rate: rate, results }, null, 2));
console.log(`results: ${file}`);
process.exitCode = rate >= PASS_THRESHOLD ? 0 : 1;
