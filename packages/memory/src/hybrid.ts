import { cosineSimilarity } from "./embedding.ts";
import type { StoredEmbedding } from "./embedding-store.ts";

// ---------------------------------------------------------------------------
// Hybrid recall helpers — Reciprocal Rank Fusion of two ranked lists, and the
// vector-pool nearest-neighbour ranking. Rank-based fusion needs no cross-scale
// calibration between BM25 scores and cosine similarities, and reduces to "just
// the non-empty list" when one side is empty (graceful degradation). (P6 U4)
// ---------------------------------------------------------------------------

export const RRF_K = 60;
export const VECTOR_TOP_N = 100;

/**
 * Reciprocal Rank Fusion. Each list is an ordered array; an item's contribution
 * from a list it appears in is 1/(k + rank) (rank is 0-based). An item present in
 * multiple lists accumulates. Returns key → fused score.
 */
export function reciprocalRankFusion<T>(lists: T[][], keyOf: (item: T) => string, k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}

/** Rank the embedding pool by cosine similarity to the query vector, top-N (sim > 0). */
export function rankVectorPool(queryVector: number[], pool: StoredEmbedding[], topN = VECTOR_TOP_N): StoredEmbedding[] {
  return pool
    .map((embedding) => ({ embedding, sim: cosineSimilarity(queryVector, embedding.vector) }))
    .filter((scored) => scored.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topN)
    .map((scored) => scored.embedding);
}
