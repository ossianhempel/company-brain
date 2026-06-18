import type { CompanyBrainDb } from "@company-brain/db";
import { createAuth, hashToken, randomToken, type Principal, type Role } from "@company-brain/auth";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

interface SeedUser {
  id?: string;
  name: string;
  email?: string;
  role?: Role;
  token: string;
}

function parseSeedUsers(raw: string | undefined): SeedUser[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u) => u && typeof u.name === "string" && typeof u.token === "string");
  } catch {
    throw new Error("COMPANY_BRAIN_USERS must be a JSON array of {id?,name,email?,role?,token} objects.");
  }
}

function rowToPrincipal(row: { id: string; name: string; email: string | null; role: string }): Principal {
  const role: Role = row.role === "admin" || row.role === "editor" ? row.role : "viewer";
  return { id: row.id, name: row.name, email: row.email, role };
}

/**
 * Build the auth layer + DB-backed session/lookup helpers from the environment.
 * Off by default (COMPANY_BRAIN_ENABLE_AUTH != "1") → single-user local admin.
 * When enabled, seeds users from COMPANY_BRAIN_USERS (tokens hashed at rest).
 */
export async function buildAuth(db: CompanyBrainDb) {
  const enabled = process.env.COMPANY_BRAIN_ENABLE_AUTH === "1";
  const sessionSecret = process.env.COMPANY_BRAIN_SESSION_SECRET ?? "";

  if (enabled && !sessionSecret) {
    throw new Error("COMPANY_BRAIN_SESSION_SECRET is required when COMPANY_BRAIN_ENABLE_AUTH=1.");
  }

  // Seed/refresh users from config. Credentials never live in the workspace git —
  // only their sha256 hashes are persisted in the (DB-canonical) users table.
  if (enabled) {
    for (const u of parseSeedUsers(process.env.COMPANY_BRAIN_USERS)) {
      const id = u.id ?? u.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const role: Role = u.role ?? "viewer";
      const existing = await db.query<{ id: string }>("select id from users where id = $1", [id]);
      if (existing.rows[0]) {
        await db.query("update users set name=$2, email=$3, role=$4, secret_hash=$5, deleted_at=null where id=$1", [
          id,
          u.name,
          u.email ?? null,
          role,
          hashToken(u.token),
        ]);
      } else {
        await db.query("insert into users (id, name, email, role, secret_hash) values ($1,$2,$3,$4,$5)", [
          id,
          u.name,
          u.email ?? null,
          role,
          hashToken(u.token),
        ]);
      }
    }
  }

  const auth = createAuth({
    enabled,
    sessionSecret,
    lookup: {
      async userByTokenHash(hash) {
        const result = await db.query<{ id: string; name: string; email: string | null; role: string }>(
          "select id, name, email, role from users where secret_hash = $1 and deleted_at is null",
          [hash]
        );
        return result.rows[0] ? rowToPrincipal(result.rows[0]) : null;
      },
      async userBySessionId(sessionId) {
        const result = await db.query<{ id: string; name: string; email: string | null; role: string }>(
          `select users.id, users.name, users.email, users.role
             from sessions join users on users.id = sessions.user_id
            where sessions.id = $1 and sessions.expires_at > now() and users.deleted_at is null`,
          [sessionId]
        );
        return result.rows[0] ? rowToPrincipal(result.rows[0]) : null;
      },
    },
  });

  return {
    auth,
    enabled,
    ttlSeconds: SESSION_TTL_SECONDS,
    /** Verify a login (email + token) and create a session; returns the session id or null. */
    async login(email: string, token: string): Promise<{ sessionId: string; principal: Principal } | null> {
      const result = await db.query<{ id: string; name: string; email: string | null; role: string }>(
        "select id, name, email, role from users where email = $1 and secret_hash = $2 and deleted_at is null",
        [email, hashToken(token)]
      );
      const row = result.rows[0];
      if (!row) return null;
      const sessionId = randomToken();
      const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
      await db.query("insert into sessions (id, user_id, expires_at) values ($1,$2,$3)", [sessionId, row.id, expires]);
      return { sessionId, principal: rowToPrincipal(row) };
    },
    async logout(sessionId: string): Promise<void> {
      await db.query("delete from sessions where id = $1", [sessionId]);
    },
  };
}

export type ServerAuth = Awaited<ReturnType<typeof buildAuth>>;
