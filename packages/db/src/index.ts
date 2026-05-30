import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";

const defaultDataDir = process.env.COMPANY_BRAIN_DATA_DIR
  ? resolve(process.cwd(), process.env.COMPANY_BRAIN_DATA_DIR)
  : resolve(process.env.INIT_CWD ?? process.cwd(), "data/pgdata");

type QueryResult<T> = { rows: T[] };

export type CompanyBrainDb = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(run: (tx: CompanyBrainDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type CreateDbOptions = {
  dataDir?: string;
  databaseUrl?: string;
};

export async function createDb(options: string | CreateDbOptions = defaultDataDir): Promise<CompanyBrainDb> {
  const databaseUrl =
    typeof options === "object" ? options.databaseUrl : process.env.COMPANY_BRAIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl) {
    return createPostgresDb(databaseUrl);
  }

  const dataDir = typeof options === "string" ? options : options.dataDir ?? defaultDataDir;
  await mkdir(dirname(dataDir), { recursive: true });
  const db = new PGlite(dataDir) as unknown as CompanyBrainDb;

  await migrateDb(db);
  return db;
}

async function createPostgresDb(databaseUrl: string): Promise<CompanyBrainDb> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = postgresAdapter(pool);
  await migrateDb(db);
  return db;
}

function postgresAdapter(pool: Pool): CompanyBrainDb {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec(sql: string) {
      return pool.query(sql);
    },
    async transaction<T>(run: (tx: CompanyBrainDb) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await run(postgresClientAdapter(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
}

function postgresClientAdapter(client: PoolClient): CompanyBrainDb {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec(sql: string) {
      return client.query(sql);
    },
    transaction(run) {
      return run(postgresClientAdapter(client));
    },
    async close() {}
  };
}

async function migrateDb(db: CompanyBrainDb) {
  await db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );
  `);

  await applyMigration(db, 1, `
    create table if not exists pages (
      id text primary key,
      title text not null,
      slug text not null default '',
      html text not null,
      plain_text text not null default '',
      creator text not null default 'system',
      created_by text not null default 'system',
      updated_by text not null default 'system',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );

    alter table pages add column if not exists slug text not null default '';
    alter table pages add column if not exists plain_text text not null default '';
    alter table pages add column if not exists creator text not null default 'system';
    alter table pages add column if not exists created_by text not null default 'system';
    alter table pages add column if not exists updated_by text not null default 'system';
    alter table pages add column if not exists deleted_at timestamptz;

    update pages set slug = id where slug = '';
    update pages set plain_text = title where plain_text = '';

    create unique index if not exists pages_slug_idx on pages (slug);
    create index if not exists pages_updated_at_idx on pages (updated_at desc);
    create index if not exists pages_deleted_at_idx on pages (deleted_at);

    create table if not exists page_links (
      source_page_id text not null references pages(id) on delete cascade,
      target_page_id text references pages(id) on delete cascade,
      target_slug text not null,
      target_title text not null,
      created_at timestamptz not null default now(),
      primary key (source_page_id, target_slug)
    );

    create index if not exists page_links_target_page_id_idx on page_links (target_page_id);
    create index if not exists page_links_target_slug_idx on page_links (target_slug);

    create table if not exists page_versions (
      id text primary key,
      page_id text not null references pages(id) on delete cascade,
      title text not null,
      slug text not null,
      html text not null,
      plain_text text not null,
      created_by text not null,
      created_at timestamptz not null default now()
    );

    create index if not exists page_versions_page_id_created_at_idx on page_versions (page_id, created_at desc);
  `);

  await applyMigration(db, 2, `
    create table if not exists page_chunks (
      id text primary key,
      page_id text not null references pages(id) on delete cascade,
      chunk_index integer not null,
      heading_path text not null default '',
      text text not null,
      html_fragment text,
      token_count integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (page_id, chunk_index)
    );

    create index if not exists page_chunks_page_id_idx on page_chunks (page_id);
    create index if not exists page_chunks_text_idx on page_chunks (text);
  `);

  await applyMigration(db, 3, `
    create table if not exists source_artifacts (
      id text primary key,
      source_type text not null,
      title text not null,
      raw_text text not null,
      metadata_json text not null default '{}',
      created_by text not null default 'system',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );

    create index if not exists source_artifacts_source_type_idx on source_artifacts (source_type);
    create index if not exists source_artifacts_created_at_idx on source_artifacts (created_at desc);
    create index if not exists source_artifacts_deleted_at_idx on source_artifacts (deleted_at);

    create table if not exists source_chunks (
      id text primary key,
      artifact_id text not null references source_artifacts(id) on delete cascade,
      chunk_index integer not null,
      text text not null,
      token_count integer not null default 0,
      created_at timestamptz not null default now(),
      unique (artifact_id, chunk_index)
    );

    create index if not exists source_chunks_artifact_id_idx on source_chunks (artifact_id);
    create index if not exists source_chunks_text_idx on source_chunks (text);

    create table if not exists memories (
      id text primary key,
      kind text not null,
      content text not null,
      subject text,
      status text not null default 'active',
      confidence real not null default 1,
      created_by text not null default 'system',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      forgotten_at timestamptz,
      superseded_by_memory_id text references memories(id)
    );

    create index if not exists memories_kind_idx on memories (kind);
    create index if not exists memories_subject_idx on memories (subject);
    create index if not exists memories_status_idx on memories (status);
    create index if not exists memories_content_idx on memories (content);

    create table if not exists memory_sources (
      id text primary key,
      memory_id text not null references memories(id) on delete cascade,
      source_type text not null,
      page_id text references pages(id) on delete set null,
      page_chunk_id text references page_chunks(id) on delete set null,
      artifact_id text references source_artifacts(id) on delete set null,
      source_chunk_id text references source_chunks(id) on delete set null,
      quote text,
      created_at timestamptz not null default now()
    );

    create index if not exists memory_sources_memory_id_idx on memory_sources (memory_id);
    create index if not exists memory_sources_page_id_idx on memory_sources (page_id);
    create index if not exists memory_sources_artifact_id_idx on memory_sources (artifact_id);
  `);

  await applyMigration(db, 4, `
    alter table pages add column if not exists pinned_order integer;
    create index if not exists pages_pinned_order_idx on pages (pinned_order);

    update pages set pinned_order = 0 where slug = 'home';
    update pages set pinned_order = 10 where slug = 'projects';
    update pages set pinned_order = 20 where slug = 'areas';
    update pages set pinned_order = 30 where slug = 'resources';
    update pages set pinned_order = 40 where slug = 'archive';
  `);

  await applyMigration(db, 5, `
    alter table memory_sources drop constraint if exists memory_sources_pkey;
    alter table memory_sources add column if not exists id text;
    update memory_sources
    set id = md5(memory_id || ':' || source_type || ':' || coalesce(page_id, '') || ':' || coalesce(page_chunk_id, '') || ':' || coalesce(artifact_id, '') || ':' || coalesce(source_chunk_id, '') || ':' || coalesce(quote, ''))
    where id is null;
    alter table memory_sources alter column id set not null;
    alter table memory_sources add primary key (id);
  `);

  await applyMigration(db, 6, `
    alter table pages add column if not exists parent_page_id text references pages(id) on delete set null;
    create index if not exists pages_parent_page_id_idx on pages (parent_page_id);

    update pages child
    set parent_page_id = parent.id
    from pages parent
    where child.parent_page_id is null
      and parent.slug = 'projects'
      and child.slug like 'projects/%';
  `);

}

async function applyMigration(db: CompanyBrainDb, version: number, sql: string) {
  const applied = await db.query<{ version: number }>("select version from schema_migrations where version = $1", [
    version
  ]);

  if (applied.rows.length > 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx.exec(sql);
    await tx.query("insert into schema_migrations (version) values ($1)", [version]);
  });
}
