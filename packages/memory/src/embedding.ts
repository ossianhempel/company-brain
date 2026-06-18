// ---------------------------------------------------------------------------
// Embedding provider seam — mirrors the agent Provider (id / detect / embed).
// Optional and off by default: when no provider is configured/available, recall
// degrades to BM25-only. The HTTP boundary is injectable so the adapter is
// testable without a network. This package owns the seam; the API-key adapter
// lives in providers/api-embedding.ts.
// ---------------------------------------------------------------------------

export interface EmbeddingDetection {
  available: boolean;
  model?: string;
  dim?: number;
  error?: string;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  /** Embedding dimensionality (rows of a different dim are ignored at query time). */
  readonly dim: number;
  detect(): Promise<EmbeddingDetection>;
  /** Embed a batch of texts → one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingRegistry {
  register(provider: EmbeddingProvider): void;
  get(id: string): EmbeddingProvider | null;
  ids(): string[];
  /** The first registered provider whose detect() reports available, or null. */
  active(): Promise<EmbeddingProvider | null>;
}

export function createEmbeddingRegistry(): EmbeddingRegistry {
  const providers = new Map<string, EmbeddingProvider>();
  return {
    register(provider) {
      providers.set(provider.id, provider);
    },
    get(id) {
      return providers.get(id) ?? null;
    },
    ids() {
      return [...providers.keys()];
    },
    async active() {
      for (const provider of providers.values()) {
        try {
          const detection = await provider.detect();
          if (detection.available) return provider;
        } catch {
          /* a provider that throws on detect is treated as unavailable */
        }
      }
      return null;
    },
  };
}

/** Cosine similarity of two equal-length vectors; 0 when either is degenerate. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
