import { randomUUID } from "node:crypto";
import { createDb, type CompanyBrainDb } from "@company-brain/db";

export type SourceArtifact = {
  id: string;
  sourceType: string;
  title: string;
  rawText: string;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type SourceChunk = {
  id: string;
  artifactId: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
};

export type MemoryKind = "fact" | "decision" | "preference" | "status" | "contradiction";
export type MemoryStatus = "active" | "superseded" | "forgotten";

export type MemorySource = {
  id: string;
  memoryId: string;
  sourceType: "page" | "page_chunk" | "artifact" | "source_chunk" | "manual";
  pageId: string | null;
  pageChunkId: string | null;
  artifactId: string | null;
  sourceChunkId: string | null;
  quote: string | null;
};

export type Memory = {
  id: string;
  kind: MemoryKind;
  content: string;
  subject: string | null;
  status: MemoryStatus;
  confidence: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  forgottenAt: string | null;
  supersededByMemoryId: string | null;
};

export type MemoryWithSources = Memory & {
  sources: MemorySource[];
};

export type RecallResult = {
  type: "memory" | "page_chunk" | "source_chunk";
  id: string;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  citation: {
    label: string;
    pageId?: string;
    pageSlug?: string;
    pageChunkId?: string;
    artifactId?: string;
    sourceChunkId?: string;
  };
  metadata: Record<string, unknown>;
};

export type RecallResponse = {
  query: string;
  searchMode: RecallSearchMode;
  results: RecallResult[];
};

export type RecallSearchMode = "lexical_v1" | "bm25_local_v1";

type SourceArtifactRow = {
  id: string;
  source_type: string;
  title: string;
  raw_text: string;
  metadata_json: string;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

type SourceChunkRow = {
  id: string;
  artifact_id: string;
  chunk_index: number;
  text: string;
  token_count: number;
};

type MemoryRow = {
  id: string;
  kind: MemoryKind;
  content: string;
  subject: string | null;
  status: MemoryStatus;
  confidence: number;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  forgotten_at: string | Date | null;
  superseded_by_memory_id: string | null;
};

type MemorySourceRow = {
  id: string;
  memory_id: string;
  source_type: MemorySource["sourceType"];
  page_id: string | null;
  page_chunk_id: string | null;
  artifact_id: string | null;
  source_chunk_id: string | null;
  quote: string | null;
};

function normalizeTimestamp(value: string | Date) {
  return value instanceof Date ? value.toISOString() : value;
}

function toArtifact(row: SourceArtifactRow): SourceArtifact {
  return {
    id: row.id,
    sourceType: row.source_type,
    title: row.title,
    rawText: row.raw_text,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdBy: row.created_by,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    deletedAt: row.deleted_at ? normalizeTimestamp(row.deleted_at) : null
  };
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    subject: row.subject,
    status: row.status,
    confidence: row.confidence,
    createdBy: row.created_by,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    forgottenAt: row.forgotten_at ? normalizeTimestamp(row.forgotten_at) : null,
    supersededByMemoryId: row.superseded_by_memory_id
  };
}

function toMemorySource(row: MemorySourceRow): MemorySource {
  return {
    id: row.id,
    memoryId: row.memory_id,
    sourceType: row.source_type,
    pageId: row.page_id,
    pageChunkId: row.page_chunk_id,
    artifactId: row.artifact_id,
    sourceChunkId: row.source_chunk_id,
    quote: row.quote
  };
}

function estimateTokenCount(text: string) {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.35);
}

function chunkText(text: string, maxWords = 180) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  for (const paragraph of paragraphs.length ? paragraphs : [text.replace(/\s+/g, " ").trim()].filter(Boolean)) {
    const words = paragraph.split(/\s+/);
    if (current.length + words.length > maxWords && current.length > 0) {
      chunks.push(current.join(" "));
      current = [];
    }

    if (words.length > maxWords) {
      if (current.length > 0) {
        chunks.push(current.join(" "));
        current = [];
      }

      for (let index = 0; index < words.length; index += maxWords) {
        chunks.push(words.slice(index, index + maxWords).join(" "));
      }
      continue;
    }

    current.push(...words);
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}

function normalizeQuery(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

function termFrequencies(text: string) {
  const frequencies = new Map<string, number>();
  for (const term of normalizeQuery(text)) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

function lexicalScore(text: string, queryTerms: string[]) {
  const normalized = text.toLowerCase();
  return queryTerms.reduce((score, term) => {
    const matches = normalized.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    return score + (matches?.length ?? 0);
  }, 0);
}

function snippet(text: string, terms: string[]) {
  const compact = text.replace(/\s+/g, " ").trim();
  const firstMatch = terms
    .map((term) => compact.toLowerCase().indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (firstMatch === undefined) {
    return compact.slice(0, 240);
  }

  const start = Math.max(0, firstMatch - 90);
  const end = Math.min(compact.length, firstMatch + 170);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

type RecallCandidate = RecallResult & {
  searchText: string;
  lexicalBoost: number;
};

function rankWithLexical(candidates: RecallCandidate[], terms: string[], limit: number) {
  return candidates
    .map((candidate) => {
      const score = lexicalScore(candidate.searchText, terms);
      return {
        ...candidate,
        score: score > 0 ? score + candidate.lexicalBoost : 0
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ searchText: _searchText, lexicalBoost: _lexicalBoost, ...result }) => result);
}

function rankWithBm25(candidates: RecallCandidate[], terms: string[], limit: number) {
  const uniqueTerms = [...new Set(terms)];
  const docs = candidates.map((candidate) => {
    const frequencies = termFrequencies(candidate.searchText);
    const length = [...frequencies.values()].reduce((sum, count) => sum + count, 0);
    return { candidate, frequencies, length };
  });
  const documentCount = Math.max(docs.length, 1);
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / documentCount || 1;
  const documentFrequency = new Map<string, number>();

  for (const term of uniqueTerms) {
    documentFrequency.set(
      term,
      docs.reduce((count, doc) => count + (doc.frequencies.has(term) ? 1 : 0), 0)
    );
  }

  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map(({ candidate, frequencies, length }) => {
      const bm25 = uniqueTerms.reduce((score, term) => {
        const frequency = frequencies.get(term) ?? 0;
        if (frequency === 0) {
          return score;
        }

        const docsWithTerm = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documentCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
        const denominator = frequency + k1 * (1 - b + b * (length / averageLength));
        return score + idf * ((frequency * (k1 + 1)) / denominator);
      }, 0);

      return {
        ...candidate,
        score: bm25 > 0 ? Number((bm25 + candidate.lexicalBoost).toFixed(4)) : 0
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ searchText: _searchText, lexicalBoost: _lexicalBoost, ...result }) => result);
}

export async function createMemoryStore(db?: CompanyBrainDb) {
  const memoryDb = db ?? (await createDb());

  async function sourcesForMemory(memoryId: string) {
    const result = await memoryDb.query<MemorySourceRow>("select * from memory_sources where memory_id = $1", [
      memoryId
    ]);
    return result.rows.map(toMemorySource);
  }

  async function writeMemorySources(memoryId: string, sources: Array<Omit<MemorySource, "id" | "memoryId">>) {
    for (const source of sources) {
      await memoryDb.query(
        `
          insert into memory_sources (
            id, memory_id, source_type, page_id, page_chunk_id, artifact_id, source_chunk_id, quote
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          randomUUID(),
          memoryId,
          source.sourceType,
          source.pageId ?? null,
          source.pageChunkId ?? null,
          source.artifactId ?? null,
          source.sourceChunkId ?? null,
          source.quote ?? null
        ]
      );
    }
  }

  return {
    async ingestArtifact(input: {
      sourceType: string;
      title: string;
      rawText: string;
      metadata?: Record<string, unknown>;
      actor?: string;
    }) {
      const id = randomUUID();
      const actor = input.actor ?? "local-user";
      const result = await memoryDb.query<SourceArtifactRow>(
        `
          insert into source_artifacts (id, source_type, title, raw_text, metadata_json, created_by)
          values ($1, $2, $3, $4, $5, $6)
          returning *
        `,
        [id, input.sourceType, input.title, input.rawText, JSON.stringify(input.metadata ?? {}), actor]
      );

      for (const [index, text] of chunkText(input.rawText).entries()) {
        await memoryDb.query(
          `
            insert into source_chunks (id, artifact_id, chunk_index, text, token_count)
            values ($1, $2, $3, $4, $5)
          `,
          [randomUUID(), id, index, text, estimateTokenCount(text)]
        );
      }

      return toArtifact(result.rows[0]);
    },

    async forgetArtifact(id: string, _actor = "local-user") {
      const result = await memoryDb.query<SourceArtifactRow>(
        `
          update source_artifacts
          set deleted_at = now(), updated_at = now()
          where id = $1 and deleted_at is null
          returning *
        `,
        [id]
      );
      const row = result.rows[0];
      return row ? toArtifact(row) : null;
    },

    async saveMemory(input: {
      kind: MemoryKind;
      content: string;
      subject?: string;
      confidence?: number;
      actor?: string;
      sources?: Array<Omit<MemorySource, "id" | "memoryId">>;
    }) {
      const id = randomUUID();
      const actor = input.actor ?? "local-user";
      const result = await memoryDb.query<MemoryRow>(
        `
          insert into memories (id, kind, content, subject, confidence, created_by)
          values ($1, $2, $3, $4, $5, $6)
          returning *
        `,
        [id, input.kind, input.content, input.subject ?? null, input.confidence ?? 1, actor]
      );
      await writeMemorySources(id, input.sources ?? []);
      return { ...toMemory(result.rows[0]), sources: await sourcesForMemory(id) };
    },

    async forgetMemory(id: string, _actor = "local-user") {
      const result = await memoryDb.query<MemoryRow>(
        `
          update memories
          set status = 'forgotten', forgotten_at = now(), updated_at = now()
          where id = $1 and status <> 'forgotten'
          returning *
        `,
        [id]
      );
      const row = result.rows[0];
      return row ? { ...toMemory(row), sources: await sourcesForMemory(row.id) } : null;
    },

    async getMemory(id: string): Promise<MemoryWithSources | null> {
      const result = await memoryDb.query<MemoryRow>("select * from memories where id = $1", [id]);
      const row = result.rows[0];
      return row ? { ...toMemory(row), sources: await sourcesForMemory(row.id) } : null;
    },

    async listMemories(input?: { status?: MemoryStatus; limit?: number }): Promise<MemoryWithSources[]> {
      const safeLimit = Math.min(Math.max(input?.limit ?? 100, 1), 500);
      const status = input?.status;
      const result = status
        ? await memoryDb.query<MemoryRow>(
            "select * from memories where status = $1 order by updated_at desc limit $2",
            [status, safeLimit]
          )
        : await memoryDb.query<MemoryRow>("select * from memories order by updated_at desc limit $1", [safeLimit]);

      return Promise.all(result.rows.map(async (row) => ({ ...toMemory(row), sources: await sourcesForMemory(row.id) })));
    },

    async recall(query: string, limit = 10, mode: RecallSearchMode = "bm25_local_v1"): Promise<RecallResponse> {
      const terms = normalizeQuery(query);
      const safeLimit = Math.min(Math.max(limit, 1), 50);
      if (terms.length === 0) {
        return { query, searchMode: mode, results: [] };
      }

      const memories = await memoryDb.query<MemoryRow>(
        "select * from memories where status = 'active' order by updated_at desc limit 500"
      );
      const memorySources = new Map<string, MemorySource[]>();
      await Promise.all(
        memories.rows.map(async (memory) => {
          memorySources.set(memory.id, await sourcesForMemory(memory.id));
        })
      );
      const pageChunks = await memoryDb.query<{
        chunk_id: string;
        page_id: string;
        page_slug: string;
        page_title: string;
        heading_path: string;
        text: string;
        updated_at: string | Date;
      }>(
        `
          select
            page_chunks.id as chunk_id,
            pages.id as page_id,
            pages.slug as page_slug,
            pages.title as page_title,
            page_chunks.heading_path,
            page_chunks.text,
            pages.updated_at
          from page_chunks
          join pages on pages.id = page_chunks.page_id
          where pages.deleted_at is null
          order by pages.updated_at desc
          limit 500
        `
      );
      const sourceChunks = await memoryDb.query<{
        chunk_id: string;
        artifact_id: string;
        artifact_title: string;
        source_type: string;
        text: string;
        created_at: string | Date;
      }>(
        `
          select
            source_chunks.id as chunk_id,
            source_artifacts.id as artifact_id,
            source_artifacts.title as artifact_title,
            source_artifacts.source_type,
            source_chunks.text,
            source_artifacts.created_at
          from source_chunks
          join source_artifacts on source_artifacts.id = source_chunks.artifact_id
          where source_artifacts.deleted_at is null
          order by source_artifacts.created_at desc
          limit 500
        `
      );

      const candidates: RecallCandidate[] = [
        ...memories.rows.map((memory) => {
          const haystack = `${memory.kind} ${memory.subject ?? ""} ${memory.content}`;
          const sources = memorySources.get(memory.id) ?? [];
          return {
            type: "memory" as const,
            id: memory.id,
            sourceId: memory.id,
            title: memory.subject ? `${memory.kind}: ${memory.subject}` : memory.kind,
            snippet: snippet(memory.content, terms),
            score: 0,
            citation: { label: `memory:${memory.id}` },
            metadata: {
              kind: memory.kind,
              subject: memory.subject,
              confidence: memory.confidence,
              createdBy: memory.created_by,
              createdAt: normalizeTimestamp(memory.created_at),
              sources
            },
            searchText: haystack,
            lexicalBoost: 5
          };
        }),
        ...pageChunks.rows.map((chunk) => {
          const haystack = `${chunk.page_title} ${chunk.page_slug} ${chunk.heading_path} ${chunk.text}`;
          return {
            type: "page_chunk" as const,
            id: chunk.chunk_id,
            sourceId: chunk.page_id,
            title: chunk.heading_path || chunk.page_title,
            snippet: snippet(chunk.text, terms),
            score: 0,
            citation: {
              label: `/${chunk.page_slug}${chunk.heading_path ? `#${chunk.heading_path}` : ""}`,
              pageId: chunk.page_id,
              pageSlug: chunk.page_slug,
              pageChunkId: chunk.chunk_id
            },
            metadata: {
              updatedAt: normalizeTimestamp(chunk.updated_at)
            },
            searchText: haystack,
            lexicalBoost: 2
          };
        }),
        ...sourceChunks.rows.map((chunk) => {
          const haystack = `${chunk.artifact_title} ${chunk.source_type} ${chunk.text}`;
          return {
            type: "source_chunk" as const,
            id: chunk.chunk_id,
            sourceId: chunk.artifact_id,
            title: chunk.artifact_title,
            snippet: snippet(chunk.text, terms),
            score: 0,
            citation: {
              label: `${chunk.source_type}:${chunk.artifact_title}`,
              artifactId: chunk.artifact_id,
              sourceChunkId: chunk.chunk_id
            },
            metadata: {
              sourceType: chunk.source_type,
              createdAt: normalizeTimestamp(chunk.created_at)
            },
            searchText: haystack,
            lexicalBoost: 1
          };
        })
      ];

      return {
        query,
        searchMode: mode,
        results:
          mode === "lexical_v1"
            ? rankWithLexical(candidates, terms, safeLimit)
            : rankWithBm25(candidates, terms, safeLimit)
      };
    }
  };
}
