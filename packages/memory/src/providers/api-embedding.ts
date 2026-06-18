import type { EmbeddingDetection, EmbeddingProvider } from "../embedding.ts";

// ---------------------------------------------------------------------------
// API-key embedding adapter — OpenAI-style POST {model, input:[...]} → {data:[{embedding}]}.
// OFF BY DEFAULT: configured purely from env; detect() is unavailable when the
// endpoint/key are unset, so recall degrades to BM25. The fetch boundary is
// injectable for tests. NOTE: configuring this transmits indexed chunk text to a
// third-party endpoint (a data-exfiltration trust boundary — see the plan Risks).
// ---------------------------------------------------------------------------

export interface ApiEmbeddingConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  dim: number;
  batchSize?: number;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponseLike>;

export class EmbeddingError extends Error {}

/** Read the API-embedding config from env, or null when not fully configured. */
export function apiEmbeddingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiEmbeddingConfig | null {
  const endpoint = env.COMPANY_BRAIN_EMBEDDING_ENDPOINT;
  const apiKey = env.COMPANY_BRAIN_EMBEDDING_API_KEY;
  const model = env.COMPANY_BRAIN_EMBEDDING_MODEL;
  const dim = Number(env.COMPANY_BRAIN_EMBEDDING_DIM);
  if (!endpoint || !apiKey || !model || !Number.isFinite(dim) || dim <= 0) return null;
  const batchSize = Number(env.COMPANY_BRAIN_EMBEDDING_BATCH);
  return { endpoint, apiKey, model, dim, batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 64 };
}

export function createApiEmbeddingProvider(
  config: ApiEmbeddingConfig,
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponseLike>
): EmbeddingProvider {
  const batchSize = config.batchSize ?? 64;
  return {
    id: "api_embedding",
    model: config.model,
    dim: config.dim,
    async detect(): Promise<EmbeddingDetection> {
      // Config-present is the availability signal (no network probe — keep detect cheap
      // and non-throwing; a real failure surfaces when embed() runs during reindex).
      if (!config.endpoint || !config.apiKey) return { available: false, error: "embedding endpoint/key not configured" };
      return { available: true, model: config.model, dim: config.dim };
    },
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const res = await fetchImpl(config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, input: batch }),
        });
        if (!res.ok) throw new EmbeddingError(`embedding request failed (${res.status})`);
        const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
        const data = body.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new EmbeddingError("embedding response shape mismatch");
        }
        for (const row of data) {
          if (!Array.isArray(row.embedding)) throw new EmbeddingError("embedding row missing vector");
          out.push(row.embedding);
        }
      }
      return out;
    },
  };
}
