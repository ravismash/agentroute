import { searchArticles, type Retriever } from "../retrieval.js";
import type { LabelledQuery } from "./queries.js";

export interface RetrievalReport {
  retriever: string;
  queries: number;
  /** Fraction of queries with at least one relevant article in the top k. */
  recallAt: Record<1 | 3 | 5, number>;
  /** Mean reciprocal rank of the first relevant article. */
  mrr: number;
  misses: { query: string; expected: string[]; got: string[] }[];
}

export async function evaluateRetrieval(
  retriever: Retriever,
  queries: readonly LabelledQuery[],
): Promise<RetrievalReport> {
  const hits = { 1: 0, 3: 0, 5: 0 };
  let reciprocalRanks = 0;
  const misses: RetrievalReport["misses"] = [];
  for (const q of queries) {
    const results = await searchArticles(retriever, q.query, 5);
    const slugs = results.map((r) => r.slug);
    const rank = slugs.findIndex((s) => q.relevant.includes(s));
    if (rank >= 0) {
      reciprocalRanks += 1 / (rank + 1);
      if (rank < 1) hits[1]++;
      if (rank < 3) hits[3]++;
      if (rank < 5) hits[5]++;
    } else {
      misses.push({ query: q.query, expected: q.relevant, got: slugs });
    }
  }
  const n = queries.length || 1;
  return {
    retriever: retriever.name,
    queries: queries.length,
    recallAt: { 1: hits[1] / n, 3: hits[3] / n, 5: hits[5] / n },
    mrr: reciprocalRanks / n,
    misses,
  };
}
