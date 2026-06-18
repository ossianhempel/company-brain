import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Auth boundary — pure, DB-agnostic. The DB lookup (token-hash → user, session
// → user) is injected so the resolution logic is testable without a database.
// Disabled by default: when off, every request is a synthetic local-user admin
// (preserving the single-user dev flow). The SSO seam is the AuthProvider shape
// below (a custom resolver can be composed in front of resolve()).
// ---------------------------------------------------------------------------

export type Role = "viewer" | "editor" | "admin";

export interface Principal {
  id: string;
  name: string;
  email: string | null;
  role: Role;
}

/** The principal used when auth is disabled — full access, single-user dev mode. */
export const LOCAL_PRINCIPAL: Principal = { id: "local-user", name: "local-user", email: null, role: "admin" };

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** True when `role` meets or exceeds `required`. */
export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Hash a bearer token / secret for at-rest comparison (tokens are high-entropy). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate a random opaque token (for provisioning user tokens / session ids). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Sign a value as `value.hmac` (HMAC-SHA256) for tamper-evident cookies. */
export function signValue(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

/** Verify a signed `value.hmac`, returning the value or null if tampered/malformed. */
export function verifySignedValue(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(value).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

/** Parse a Cookie header for a named cookie value. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const SESSION_COOKIE = "cb_session";

/** The access requirement for a route. `public` → no role check (any/no principal). */
export type RouteRequirement = { kind: "public" } | { kind: "role"; role: Role };

const ADMIN_PATTERNS = [/^\/api\/admin\//, /^\/api\/agents\/[^/]+\/run$/];

/**
 * RBAC policy by method + path. Reads require viewer, writes editor, and
 * host-execution / admin routes (agent run, admin reindex) require admin.
 * Auth + liveness routes are public (the auth middleware handles their identity).
 */
export function routeRequirement(method: string, path: string): RouteRequirement {
  if (path === "/health" || path.startsWith("/api/auth/")) return { kind: "public" };
  if (ADMIN_PATTERNS.some((re) => re.test(path))) return { kind: "role", role: "admin" };
  const verb = method.toUpperCase();
  const isWrite = verb !== "GET" && verb !== "HEAD" && verb !== "OPTIONS";
  return { kind: "role", role: isWrite ? "editor" : "viewer" };
}

/** DB-backed lookups, injected by the server. */
export interface AuthLookup {
  userByTokenHash(hash: string): Promise<Principal | null>;
  userBySessionId(sessionId: string): Promise<Principal | null>;
}

export interface AuthConfig {
  enabled: boolean;
  sessionSecret: string;
  lookup: AuthLookup;
}

export interface RequestIdentity {
  authorization?: string;
  cookie?: string;
}

export function createAuth(config: AuthConfig) {
  return {
    get enabled() {
      return config.enabled;
    },
    /** Resolve the principal for a request, or null when auth is on and unauthenticated. */
    async resolve(req: RequestIdentity): Promise<Principal | null> {
      if (!config.enabled) return LOCAL_PRINCIPAL;
      const bearer = req.authorization?.startsWith("Bearer ") ? req.authorization.slice(7).trim() : null;
      if (bearer) {
        const principal = await config.lookup.userByTokenHash(hashToken(bearer));
        if (principal) return principal;
      }
      const signed = readCookie(req.cookie, SESSION_COOKIE);
      if (signed) {
        const sessionId = verifySignedValue(signed, config.sessionSecret);
        if (sessionId) {
          const principal = await config.lookup.userBySessionId(sessionId);
          if (principal) return principal;
        }
      }
      return null;
    },
    /** Build a signed Set-Cookie value for a session id. */
    sessionCookie(sessionId: string, maxAgeSeconds: number): string {
      const signed = signValue(sessionId, config.sessionSecret);
      return `${SESSION_COOKIE}=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
    },
    clearCookie(): string {
      return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
