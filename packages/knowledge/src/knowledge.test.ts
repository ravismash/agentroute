import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ARTICLES,
  Bm25Retriever,
  CachedEmbeddings,
  chunkArticles,
  createRetriever,
  evaluateRetrieval,
  expandQuery,
  HELD_OUT_QUERIES,
  HybridRetriever,
  RETRIEVAL_QUERIES,
  searchArticles,
  stem,
  tokenize,
  VectorRetriever,
  type EmbeddingProvider,
  type RankedChunk,
  type Retriever,
} from "./index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("text processing", () => {
  it.each([
    ["refunds", "refund"],
    ["refunded", "refund"],
    ["charges", "charg"],
    ["charge", "charg"],
    ["downgrading", "downgrad"],
    ["downgrade", "downgrad"],
    ["policies", "policy"],
  ])("stems %s → %s", (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  it("drops stopwords and folds accents", () => {
    expect(tokenize("How do I get my DEVOLUCIÓN?")).toEqual(["devolucion"]);
  });

  it("expands customer phrasing with domain synonyms", () => {
    expect(expandQuery("charged twice")).toEqual(expect.arrayContaining(["charg", "twic", "duplicat"]));
  });
});

describe("chunking", () => {
  const chunks = chunkArticles();

  it("splits every article into titled sections", () => {
    expect(new Set(chunks.map((c) => c.slug)).size).toBe(ARTICLES.length);
    expect(chunks.every((c) => c.heading && c.text && c.id.startsWith(`${c.slug}#`))).toBe(true);
  });

  it("has unique article slugs and chunk ids", () => {
    expect(new Set(ARTICLES.map((a) => a.slug)).size).toBe(ARTICLES.length);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it("labels only articles that exist", () => {
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    for (const q of [...RETRIEVAL_QUERIES, ...HELD_OUT_QUERIES]) {
      for (const s of q.relevant) expect(slugs.has(s), `${q.query} → ${s}`).toBe(true);
    }
  });
});

describe("BM25 retrieval", () => {
  const retriever = new Bm25Retriever(chunkArticles());

  it("finds the refund timing article for a timing question", async () => {
    const results = await searchArticles(retriever, "how many days until my refund reaches my card", 3);
    const timing = results.find((r) => r.slug === "refund-timing");
    expect(timing?.url).toBe("https://help.acme.test/articles/refund-timing");
    expect(timing?.snippet).toMatch(/5–10 business days/);
  });

  it("returns at most one result per article", async () => {
    const results = await searchArticles(retriever, "refund", 5);
    expect(new Set(results.map((r) => r.slug)).size).toBe(results.length);
  });

  it("documents a known lexical gap that vector search addresses", async () => {
    // "show up" shares no words with "appears on your statement": BM25 misses it.
    const results = await searchArticles(retriever, "when will the money show up back on my card", 3);
    expect(results.map((r) => r.slug)).not.toContain("refund-timing");
  });

  it("returns nothing for an unrelated query", async () => {
    expect(await searchArticles(retriever, "zxqv blorf")).toEqual([]);
  });

  // Regression guards, not targets: the held-out set measures generalization honestly.
  it("meets the retrieval quality floor on the dev set", async () => {
    const report = await evaluateRetrieval(retriever, RETRIEVAL_QUERIES);
    expect(report.recallAt[5]).toBeGreaterThanOrEqual(0.95);
    expect(report.mrr).toBeGreaterThanOrEqual(0.85);
  });

  it("meets the floor on the held-out set (never used for tuning)", async () => {
    const report = await evaluateRetrieval(retriever, HELD_OUT_QUERIES);
    expect(report.recallAt[5]).toBeGreaterThanOrEqual(0.7);
  });
});

/** Deterministic fake embeddings: bag-of-letters vectors. */
class FakeEmbeddings implements EmbeddingProvider {
  readonly model = "fake";
  calls = 0;
  embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return Promise.resolve(
      texts.map((t) => {
        const v = new Array<number>(26).fill(0);
        for (const ch of t.toLowerCase()) {
          const i = ch.charCodeAt(0) - 97;
          if (i >= 0 && i < 26) v[i] = (v[i] ?? 0) + 1;
        }
        return v;
      }),
    );
  }
}

describe("embeddings and hybrid retrieval", () => {
  it("caches embeddings on disk so unchanged content is never re-embedded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-"));
    dirs.push(dir);
    const inner = new FakeEmbeddings();
    const first = new CachedEmbeddings(inner, join(dir, "cache.json"));
    await first.embed(["a", "b"]);
    await first.embed(["a", "b"]);
    const second = new CachedEmbeddings(inner, join(dir, "cache.json"));
    await second.embed(["a", "b"]);
    expect(inner.calls).toBe(1);
  });

  it("ranks by cosine similarity", async () => {
    const chunks = chunkArticles().slice(0, 5);
    const results = await new VectorRetriever(chunks, new FakeEmbeddings()).search(chunks[2]?.title ?? "", 1);
    expect(results).toHaveLength(1);
  });

  it("fuses rankings with reciprocal rank fusion", async () => {
    const chunks = chunkArticles();
    const byId = (id: string) => {
      const chunk = chunks.find((c) => c.id === id);
      if (!chunk) throw new Error(`no chunk ${id}`);
      return chunk;
    };
    const fixed = (name: string, ids: string[]): Retriever => ({
      name,
      search: () => Promise.resolve(ids.map((id): RankedChunk => ({ chunk: byId(id), score: 1 }))),
    });
    const a = chunks[0]?.id ?? "";
    const b = chunks[1]?.id ?? "";
    const c = chunks[2]?.id ?? "";
    // b is second in both lists, a and c are first in only one: b wins.
    const hybrid = new HybridRetriever([fixed("x", [a, b]), fixed("y", [c, b])]);
    const [top] = await hybrid.search("q", 3);
    expect(top?.chunk.id).toBe(b);
  });

  it("uses BM25 alone without embeddings, hybrid with them", () => {
    expect(createRetriever().name).toBe("bm25");
    expect(createRetriever(new FakeEmbeddings()).name).toBe("hybrid");
  });
});
