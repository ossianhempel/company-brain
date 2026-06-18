import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuth,
  hashToken,
  signValue,
  verifySignedValue,
  readCookie,
  roleAtLeast,
  LOCAL_PRINCIPAL,
  SESSION_COOKIE,
  type AuthLookup,
  type Principal,
} from "./index.ts";

const ada: Principal = { id: "u1", name: "Ada", email: "ada@x.io", role: "editor" };

function lookup(over: Partial<AuthLookup> = {}): AuthLookup {
  return {
    userByTokenHash: async () => null,
    userBySessionId: async () => null,
    ...over,
  };
}

test("disabled auth resolves the synthetic local-user admin", async () => {
  const auth = createAuth({ enabled: false, sessionSecret: "s", lookup: lookup() });
  assert.deepEqual(await auth.resolve({}), LOCAL_PRINCIPAL);
});

test("a valid bearer token resolves its user; invalid → null", async () => {
  const auth = createAuth({
    enabled: true,
    sessionSecret: "s",
    lookup: lookup({ userByTokenHash: async (h) => (h === hashToken("secret-token") ? ada : null) }),
  });
  assert.deepEqual(await auth.resolve({ authorization: "Bearer secret-token" }), ada);
  assert.equal(await auth.resolve({ authorization: "Bearer wrong" }), null);
  assert.equal(await auth.resolve({}), null); // missing → null when enabled
});

test("a valid signed session cookie resolves; tampered → null", async () => {
  const secret = "session-secret";
  const auth = createAuth({
    enabled: true,
    sessionSecret: secret,
    lookup: lookup({ userBySessionId: async (id) => (id === "sess-1" ? ada : null) }),
  });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue("sess-1", secret))}`;
  assert.deepEqual(await auth.resolve({ cookie }), ada);

  const tampered = `${SESSION_COOKIE}=${encodeURIComponent("sess-1.deadbeef")}`;
  assert.equal(await auth.resolve({ cookie: tampered }), null);
});

test("signValue/verifySignedValue round-trips and rejects tampering", () => {
  const v = signValue("hello", "k");
  assert.equal(verifySignedValue(v, "k"), "hello");
  assert.equal(verifySignedValue(v, "wrong-key"), null);
  assert.equal(verifySignedValue("hello.bad", "k"), null);
  assert.equal(verifySignedValue("nodot", "k"), null);
});

test("readCookie extracts a named cookie", () => {
  assert.equal(readCookie("a=1; cb_session=xyz; b=2", "cb_session"), "xyz");
  assert.equal(readCookie(undefined, "cb_session"), null);
});

test("roleAtLeast ranks viewer < editor < admin", () => {
  assert.equal(roleAtLeast("admin", "editor"), true);
  assert.equal(roleAtLeast("editor", "editor"), true);
  assert.equal(roleAtLeast("viewer", "editor"), false);
  assert.equal(roleAtLeast("editor", "admin"), false);
});
