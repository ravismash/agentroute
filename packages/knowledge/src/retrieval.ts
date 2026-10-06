import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ARTICLES, HELP_CENTER_BASE_URL, type Article } from "./articles.js";
import { expandQuery, tokenize } from "./text.js";

export interface Chunk {
  /** `<slug>#<section-index>` */
  id: string;
  slug: string;
  title: string;
  heading: string;
  text: string;
}

/** One chunk per "## " section, prefixed with the article title for context. */
export function chunkArticles(articles: readonly Article[] = ARTICLES): Chunk[] {
  return articles.flatMap((article) =>
    article.body
      .split(/^## /m)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((section, i) => {
        const [heading = "", ...rest] = section.split("\n");
        return {
          id: `${article.slug}#${i}`,
          slug: article.slug,
          title: article.title,
          heading: heading.trim(),
          text: rest.join("\n").trim(),
        };
      }),
  );
}

export interface RankedChunk {
  chunk: Chunk;
  score: number;
}

export interface Retriever {
  readonly name: string;
  search(query: string, k: number): Promise<RankedChunk[]>;
}

/** Okapi BM25 over chunks; title and heading are weighted ×2. */
export class Bm25Retriever implements Retriever {
  readonly name = "bm25";
  private readonly docs: { chunk: Chunk; tf: Map<string, number>; length: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(
    chunks: readonly Chunk[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    this.docs = chunks.map((chunk) => {
      const tokens = [
        ...tokenize(chunk.title),
        ...tokenize(chunk.title),
        ...tokenize(chunk.heading),
        ...tokenize(chunk.heading),
        ...tokenize(chunk.text),
      ];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { chunk, tf, length: tokens.length };
    });
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, k: number): Promise<RankedChunk[]> {
    const terms = expandQuery(query);
    const n = this.docs.length;
    const ranked = this.docs
      .map((d) => {
        let score = 0;
        for (const term of terms) {
          const f = d.tf.get(term);
          if (!f) continue;
          const df = this.df.get(term) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score +=
            (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avgLength));
        }
        return { chunk: d.chunk, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return Promise.resolve(ranked.slice(0, k));
  }
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Any OpenAI-compatible `/embeddings` endpoint (OpenAI, OpenRouter, or a local server). */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`embeddings request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/** Disk cache keyed by sha256(model + text): re-indexing unchanged content costs nothing. */
export class CachedEmbeddings implements EmbeddingProvider {
  private cache: Record<string, number[]> | undefined;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly file: string,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.cache ??= await readFile(this.file, "utf8")
      .then((s) => JSON.parse(s) as Record<string, number[]>)
      .catch(() => ({}));
    const cache = this.cache;
    const key = (t: string) => createHash("sha256").update(`${this.inner.model}\n${t}`).digest("hex");
    const missing = [...new Set(texts.filter((t) => !cache[key(t)]))];
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += 64) {
        const batch = missing.slice(i, i + 64);
        const vectors = await this.inner.embed(batch);
        batch.forEach((t, j) => (cache[key(t)] = vectors[j] ?? []));
      }
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(cache));
    }
    return texts.map((t) => cache[key(t)] ?? []);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class VectorRetriever implements Retriever {
  readonly name = "vector";
  private vectors: number[][] | undefined;

  constructor(
    private readonly chunks: readonly Chunk[],
    private readonly embeddings: EmbeddingProvider,
  ) {}

  private static textOf(c: Chunk): string {
    return `${c.title}\n${c.heading}\n${c.text}`;
  }

  async search(query: string, k: number): Promise<RankedChunk[]> {
    this.vectors ??= await this.embeddings.embed(this.chunks.map((c) => VectorRetriever.textOf(c)));
    const [q = []] = await this.embeddings.embed([query]);
    const vectors = this.vectors;
    return this.chunks
      .map((chunk, i) => ({ chunk, score: cosine(q, vectors[i] ?? []) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/**
 * Reciprocal Rank Fusion: score = Σ 1 / (k + rank). Robust to the different
 * score scales of BM25 and cosine similarity; k = 60 is the standard constant.
 */
export class HybridRetriever implements Retriever {
  readonly name = "hybrid";

  constructor(
    private readonly retrievers: readonly Retriever[],
    private readonly rrfK = 60,
    private readonly depth = 20,
  ) {}

  async search(query: string, k: number): Promise<RankedChunk[]> {
    const lists = await Promise.all(this.retrievers.map((r) => r.search(query, this.depth)));
    const fused = new Map<string, RankedChunk>();
    for (const list of lists) {
      list.forEach(({ chunk }, rank) => {
        const entry = fused.get(chunk.id) ?? { chunk, score: 0 };
        entry.score += 1 / (this.rrfK + rank + 1);
        fused.set(chunk.id, entry);
      });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }
}

// ─── Article-level search used by the agent ──────────────────────────────────

export interface SearchResult {
  slug: string;
  title: string;
  url: string;
  /** The best-matching section, used as grounding text for the answer. */
  snippet: string;
  score: number;
}

/** Search chunks, then keep the best chunk per article. */
export async function searchArticles(retriever: Retriever, query: string, k = 3): Promise<SearchResult[]> {
  const chunks = await retriever.search(query, k * 4);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const { chunk, score } of chunks) {
    if (seen.has(chunk.slug)) continue;
    seen.add(chunk.slug);
    results.push({
      slug: chunk.slug,
      title: chunk.title,
      url: `${HELP_CENTER_BASE_URL}${chunk.slug}`,
      snippet: `${chunk.heading}: ${chunk.text}`,
      score,
    });
    if (results.length === k) break;
  }
  return results;
}

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

/**
 * Embeddings from the environment: OpenRouter (preferred) or OpenAI. Returns
 * undefined when no key is set, so callers fall back to BM25 only.
 */
export function embeddingsFromEnv(env: NodeJS.ProcessEnv, cacheFile: string): EmbeddingProvider | undefined {
  const model = env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  if (env.OPENROUTER_API_KEY) {
    return new CachedEmbeddings(
      new OpenAICompatibleEmbeddings(model, env.OPENROUTER_API_KEY, "https://openrouter.ai/api/v1"),
      cacheFile,
    );
  }
  if (env.OPENAI_API_KEY) {
    return new CachedEmbeddings(
      new OpenAICompatibleEmbeddings(model.replace(/^openai\//, ""), env.OPENAI_API_KEY),
      cacheFile,
    );
  }
  return undefined;
}

/** BM25 alone, or BM25 + vectors fused with RRF when embeddings are available. */
export function createRetriever(embeddings?: EmbeddingProvider, chunks = chunkArticles()): Retriever {
  const bm25 = new Bm25Retriever(chunks);
  return embeddings ? new HybridRetriever([bm25, new VectorRetriever(chunks, embeddings)]) : bm25;
}
