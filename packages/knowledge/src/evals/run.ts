/**
 * Retrieval evals: recall@k and MRR on the dev and held-out query sets.
 *
 *   pnpm --filter @agentroute/knowledge eval:retrieval
 *
 * BM25 always runs. With OPENROUTER_API_KEY or OPENAI_API_KEY set, vector and
 * hybrid (RRF) retrieval run too, so the three can be compared.
 */
import { fileURLToPath } from "node:url";
import {
  Bm25Retriever,
  chunkArticles,
  embeddingsFromEnv,
  HybridRetriever,
  VectorRetriever,
  type Retriever,
} from "../retrieval.js";
import { evaluateRetrieval } from "./metrics.js";
import { HELD_OUT_QUERIES, RETRIEVAL_QUERIES } from "./queries.js";

const CACHE = fileURLToPath(new URL("../../../../.cache/embeddings.json", import.meta.url));

const chunks = chunkArticles();
const bm25 = new Bm25Retriever(chunks);
const retrievers: Retriever[] = [bm25];
const embeddings = embeddingsFromEnv(process.env, CACHE);
if (embeddings) {
  const vector = new VectorRetriever(chunks, embeddings);
  retrievers.push(vector, new HybridRetriever([bm25, vector]));
  console.log(`embeddings: ${embeddings.model}`);
} else {
  console.log("no embedding key set: BM25 only (set OPENROUTER_API_KEY to compare vector and hybrid)");
}

console.log(
  `\n${"retriever".padEnd(10)} ${"set".padEnd(9)} ${"n".padStart(3)}  recall@1  recall@3  recall@5   MRR`,
);
for (const retriever of retrievers) {
  for (const [name, set] of [
    ["dev", RETRIEVAL_QUERIES],
    ["held-out", HELD_OUT_QUERIES],
  ] as const) {
    const r = await evaluateRetrieval(retriever, set);
    const f = (x: number) => x.toFixed(2).padStart(8);
    console.log(
      `${retriever.name.padEnd(10)} ${name.padEnd(9)} ${String(r.queries).padStart(3)}  ${f(r.recallAt[1])}  ${f(r.recallAt[3])}  ${f(r.recallAt[5])}  ${f(r.mrr)}`,
    );
  }
}
