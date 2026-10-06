/** Small statistics helpers for eval reporting (pure, unit-tested). */

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/**
 * Agreement between two binary raters (e.g. judge vs human labels).
 * Cohen's kappa corrects raw agreement for agreement expected by chance:
 * > 0.8 strong, 0.6–0.8 substantial, < 0.4 weak.
 */
export function agreement(
  a: readonly boolean[],
  b: readonly boolean[],
): {
  accuracy: number;
  kappa: number;
  confusion: { tp: number; tn: number; fp: number; fn: number };
} {
  if (a.length !== b.length) throw new Error("rater arrays differ in length");
  const n = a.length;
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  a.forEach((x, i) => {
    const y = b[i];
    if (x && y) tp++;
    else if (!x && !y) tn++;
    else if (x && !y) fp++;
    else fn++;
  });
  const po = n ? (tp + tn) / n : 0;
  const pYes = n ? ((tp + fp) / n) * ((tp + fn) / n) : 0;
  const pNo = n ? ((tn + fn) / n) * ((tn + fp) / n) : 0;
  const pe = pYes + pNo;
  return { accuracy: po, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe), confusion: { tp, tn, fp, fn } };
}

export interface ModelPricing {
  /** USD per token. */
  prompt: number;
  completion: number;
}

/** Live per-token prices from OpenRouter's public model list (no key required). */
export async function fetchOpenRouterPricing(): Promise<Map<string, ModelPricing>> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`pricing request failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    data: { id: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  return new Map(
    body.data.map((m) => [
      m.id,
      { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) },
    ]),
  );
}

export function costUsd(
  usage: { input_tokens: number; output_tokens: number },
  pricing: ModelPricing | undefined,
): number {
  return pricing
    ? usage.input_tokens * pricing.prompt + usage.output_tokens * pricing.completion
    : Number.NaN;
}
