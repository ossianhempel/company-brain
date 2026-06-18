import { createHash } from "node:crypto";
import type { CompanyBrainDb } from "@company-brain/db";
import type { EmbeddingProvider, EmbeddingRegistry } from "./embedding.ts";

// ---------------------------------------------------------------------------
// Embedding store — populates the derived chunk_embeddings table from chunk text
// during reindex, keyed by STABLE identity (chunk_type, owner_id, chunk_index,
// model) so a content-hash skip survives chunk-row-id churn. Best-effort: a
// failure logs and leaves BM25 intact; no provider → no-op. (P6 U3)
// ---------------------------------------------------------------------------

export type ChunkType = "memory" | "page_chunk" | "source_chunk";

export interface EmbeddableChunk {
  chunkType: ChunkType;
  ownerId: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
}

export interface StoredEmbedding {
  chunkType: ChunkType;
  ownerId: string;
  chunkIndex: number;
  vector: number[];
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Gather every embeddable chunk (active memories + page/source chunks) with a
 *  stable identity and a content hash. owner_id/chunk_index are stable across reindex. */
export async function gatherChunks(db: CompanyBrainDb): Promise<EmbeddableChunk[]> {
  const out: EmbeddableChunk[] = [];

  // memories use `status` for lifecycle (active/superseded/forgotten) — no deleted_at column.
  const memories = await db.query<{ id: string; kind: string; subject: string | null; content: string }>(
    "select id, kind, subject, content from memories where status = 'active'"
  );
  for (const m of memories.rows) {
    const text = `${m.kind} ${m.subject ?? ""} ${m.content}`.trim();
    out.push({ chunkType: "memory", ownerId: m.id, chunkIndex: 0, text, contentHash: hashText(text) });
  }

  const pageChunks = await db.query<{ page_id: string; chunk_index: number; text: string }>(
    `select page_chunks.page_id, page_chunks.chunk_index, page_chunks.text
       from page_chunks join pages on pages.id = page_chunks.page_id
      where pages.deleted_at is null`
  );
  for (const c of pageChunks.rows) {
    out.push({ chunkType: "page_chunk", ownerId: c.page_id, chunkIndex: c.chunk_index, text: c.text, contentHash: hashText(c.text) });
  }

  const sourceChunks = await db.query<{ artifact_id: string; chunk_index: number; text: string }>(
    `select source_chunks.artifact_id, source_chunks.chunk_index, source_chunks.text
       from source_chunks join source_artifacts on source_artifacts.id = source_chunks.artifact_id
      where source_artifacts.deleted_at is null`
  );
  for (const c of sourceChunks.rows) {
    out.push({ chunkType: "source_chunk", ownerId: c.artifact_id, chunkIndex: c.chunk_index, text: c.text, contentHash: hashText(c.text) });
  }

  return out;
}

/** Embed the chunks that are new or changed (content-hash skip on the stable key),
 *  then upsert. Returns the count actually (re)embedded. */
export async function embedChunks(db: CompanyBrainDb, provider: EmbeddingProvider, chunks: EmbeddableChunk[]): Promise<number> {
  const stale: EmbeddableChunk[] = [];
  for (const chunk of chunks) {
    const existing = await db.query<{ content_hash: string }>(
      "select content_hash from chunk_embeddings where chunk_type=$1 and owner_id=$2 and chunk_index=$3 and model=$4",
      [chunk.chunkType, chunk.ownerId, chunk.chunkIndex, provider.model]
    );
    if (existing.rows[0]?.content_hash !== chunk.contentHash) stale.push(chunk);
  }
  if (stale.length === 0) return 0;

  const vectors = await provider.embed(stale.map((c) => c.text));
  for (let i = 0; i < stale.length; i++) {
    const chunk = stale[i];
    const vector = vectors[i];
    await db.query(
      `insert into chunk_embeddings (chunk_type, owner_id, chunk_index, model, dim, vector_json, content_hash)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (chunk_type, owner_id, chunk_index, model) do update set
         dim = excluded.dim, vector_json = excluded.vector_json, content_hash = excluded.content_hash, created_at = now()`,
      [chunk.chunkType, chunk.ownerId, chunk.chunkIndex, provider.model, vector.length, JSON.stringify(vector), chunk.contentHash]
    );
  }
  return stale.length;
}

/** Reindex embeddings for all chunks. No provider/available → no-op. Best-effort:
 *  a provider failure logs and leaves existing embeddings intact (never throws). */
export async function reindexEmbeddings(db: CompanyBrainDb, embeddings?: EmbeddingRegistry): Promise<{ embedded: number } | null> {
  if (!embeddings) return null;
  const provider = await embeddings.active();
  if (!provider) return null;
  try {
    const chunks = await gatherChunks(db);
    const embedded = await embedChunks(db, provider, chunks);
    return { embedded };
  } catch (err) {
    console.error("[embeddings] reindex failed (recall stays BM25-only):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Max embeddings pulled into memory for the brute-force vector scan. Bounds the O(N)
 *  cost on PGlite; when exceeded, the oldest embeddings fall out of the pool (a recall
 *  recency limit — documented). NOTE: the indexed ANN path (pgvector `<=>` query) on
 *  large Postgres deployments is a deferred follow-up; today both backends brute-force. */
export const MAX_VECTOR_POOL = 5000;

/** Load stored embeddings for a model (the brute-force vector pool), most-recent first,
 *  bounded by MAX_VECTOR_POOL with a log when the bound truncates the pool. */
export async function loadEmbeddings(db: CompanyBrainDb, model: string): Promise<StoredEmbedding[]> {
  const total = await db.query<{ c: number }>("select count(*)::int as c from chunk_embeddings where model = $1", [model]);
  if ((total.rows[0]?.c ?? 0) > MAX_VECTOR_POOL) {
    console.warn(
      `[embeddings] vector pool for model ${model} has ${total.rows[0].c} rows; scanning the newest ${MAX_VECTOR_POOL} (brute-force limit). Use Postgres + pgvector for ANN at scale.`
    );
  }
  const rows = await db.query<{ chunk_type: ChunkType; owner_id: string; chunk_index: number; vector_json: string }>(
    "select chunk_type, owner_id, chunk_index, vector_json from chunk_embeddings where model = $1 order by created_at desc limit $2",
    [model, MAX_VECTOR_POOL]
  );
  return rows.rows.map((r) => ({
    chunkType: r.chunk_type,
    ownerId: r.owner_id,
    chunkIndex: r.chunk_index,
    vector: JSON.parse(r.vector_json) as number[],
  }));
}

/**
 * Optional pgvector upgrade — Postgres-only, autocommit, OUTSIDE the versioned
 * migration (KTD2b). Probes for the extension; if present, mirrors vector_json into
 * a real `vector` column + an HNSW index. No-op on PGlite or when absent; best-effort
 * (logs and returns false on any failure). Today recall reads vector_json (portable);
 * the pgvector column is groundwork for an ANN query path on large Postgres deployments.
 */
export async function setupPgVector(db: CompanyBrainDb, opts: { isPostgres: boolean }): Promise<boolean> {
  if (!opts.isPostgres) return false;
  try {
    const avail = await db.query<{ name: string }>("select name from pg_available_extensions where name = 'vector'");
    if (avail.rows.length === 0) return false;
    await db.query("create extension if not exists vector");
    return true;
  } catch (err) {
    console.error("[embeddings] pgvector setup skipped:", err instanceof Error ? err.message : err);
    return false;
  }
}
