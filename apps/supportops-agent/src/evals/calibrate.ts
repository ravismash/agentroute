/**
 * Judge calibration: how well does the LLM judge agree with hand labels?
 *
 *   pnpm --filter @agentroute/supportops-agent evals:judge-calibrate
 *
 * Only trust judge scores if kappa is substantial (≥ 0.6).
 */
import { judge, judgeFromEnv } from "./judge.js";
import { JUDGE_LABELS } from "./judge-labels.js";
import { agreement } from "./stats.js";

const configured = judgeFromEnv(process.env);
if (!configured) {
  console.error("No judge configured. Set OPENROUTER_API_KEY (and optionally JUDGE_MODEL).");
  process.exit(2);
}

console.log(`Calibrating judge ${configured.model} on ${JUDGE_LABELS.length} labelled replies\n`);
const human: boolean[] = [];
const model: boolean[] = [];
for (const label of JUDGE_LABELS) {
  try {
    const verdict = await judge(configured.client, label);
    human.push(label.pass);
    model.push(verdict.pass);
    const mark = verdict.pass === label.pass ? "agree   " : "DISAGREE";
    const s = verdict.scores;
    console.log(
      `${mark} ${label.id.padEnd(4)} human=${label.pass ? "pass" : "fail"} judge=${verdict.pass ? "pass" : "fail"} ` +
        `[F${s.faithfulness} S${s.safety} T${s.tone} R${s.resolution}] ${label.why}`,
    );
  } catch (err) {
    console.log(`ERROR    ${label.id}: ${(err as Error).message}`);
  }
}
const a = agreement(human, model);
console.log(
  `\nagreement ${(a.accuracy * 100).toFixed(0)}% · Cohen's kappa ${a.kappa.toFixed(2)} · ` +
    `confusion tp=${a.confusion.tp} tn=${a.confusion.tn} fp=${a.confusion.fp} fn=${a.confusion.fn}`,
);
process.exitCode = a.kappa >= 0.6 ? 0 : 1;
