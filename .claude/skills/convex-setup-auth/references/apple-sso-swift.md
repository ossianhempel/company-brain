# Apple SSO for Swift (iOS) + Convex Custom JWT

Use this reference when the user wants **Sign in with Apple in a native Swift/SwiftUI iOS app talking to Convex**. There is no first-party Convex Auth iOS SDK for SIWA, so the pattern is:

1. iOS does native **Sign in with Apple** via `AuthenticationServices`.
2. The Apple identity token is POSTed to a Convex HTTP action which verifies it, upserts a `users` row, and **mints our own RS256 session JWT + refresh JWT** signed by a keypair *we* own.
3. Convex `auth.config.ts` is configured as a **`customJwt`** provider pointing at our own JWKS endpoint (served from the same Convex deployment at `/.well-known/jwks.json`).
4. The iOS client implements `ConvexMobile.AuthProvider` and hands the session JWT to `ConvexClientWithAuth` via the `onIdToken` callback. Apple is out of the loop after step 2 — refreshes hit our own `/auth/refresh` endpoint.

This pattern is in production in three repos — read them as the source of truth before reimplementing:

- **petalpal** — `~/Developer/petalpal/`
  - `convex/auth.config.ts` — Custom JWT provider config
  - `convex/http.ts` — `/auth/apple/exchange` + `/auth/refresh` HTTP actions, JWKS endpoint
  - `convex/lib/jwt.ts` — `mintSessionTokens`, RS256 signing, nonce verification
  - `convex/lib/auth.ts` — `requireUser` / `getCurrentUser` helpers (identity.subject is `users._id`)
  - `ios/PetalPal/Services/AppleConvexAuthProvider.swift` — full client implementation
- **skinlytix** — `~/Developer/skinlytix/`
  - Same `convex/auth.config.ts` + `convex/lib/auth.ts` shape
  - `ios/Skinlytix/Core/Services/AppleConvexAuthProvider.swift`
  - `ios/Skinlytix/Features/AuthGateView.swift` and `AuthenticatedRoot.swift` for SwiftUI gating
- **shotly** — `~/Developer/shotly/`
  - `Shotly/Services/AppleConvexAuthProvider.swift` and `AuthService.swift`

**When in doubt, copy from petalpal first — it has the most thorough comments and the cleanest split between `lib/jwt.ts` and `http.ts`.** Skinlytix has the most complete SwiftUI gating patterns to crib from.

## Required Convex env vars

Set via `npx convex env set` (and again for prod deployment):

- `AUTH_JWT_ISSUER` — stable issuer string baked into our session JWTs (e.g. `"https://petalpal.app"`). Must match the `iss` claim minted in `convex/lib/jwt.ts`.
- `APPLE_BUNDLE_ID` — the iOS bundle id; used as **both** the Apple-token audience check AND the `aud` claim in our own session JWTs.
- `AUTH_JWT_PRIVATE_KEY` — PKCS#8 PEM, RS256.
- `AUTH_JWT_PUBLIC_KEY` — SPKI PEM, RS256 (served via JWKS at `/.well-known/jwks.json`).

`CONVEX_SITE_URL` is set automatically.

## Architecture at a glance

```
iOS app                                Convex (HTTP actions)
─────────                              ─────────────────────
ASAuthorizationAppleIDRequest
  nonce = SHA256(rawNonce) ──► Apple ──► identityToken (JWT, 10min TTL)
                                       │
POST /auth/apple/exchange ◄────────────┘
  { identityToken, rawNonce, email?, name? }
                              │
                              ├─ verify Apple JWT (iss, aud=APPLE_BUNDLE_ID, exp, sig via Apple JWKS)
                              ├─ verify nonce: SHA256(rawNonce) === claim.nonce
                              ├─ upsert users row keyed by Apple `sub`
                              └─ mintSessionTokens() → { sessionToken (1h), refreshToken (30d) }
                                  signed RS256 with AUTH_JWT_PRIVATE_KEY
                                  sub = users._id, iss = AUTH_JWT_ISSUER, aud = APPLE_BUNDLE_ID

iOS persists tokens in Keychain, hands sessionToken to ConvexClientWithAuth.

ConvexClient → Convex (WebSocket) ──► validates session JWT against customJwt provider
                                       (JWKS at $CONVEX_SITE_URL/.well-known/jwks.json)
                                       identity.subject = users._id
```

## Server side — Convex pieces

`convex/auth.config.ts`:

```ts
export default {
  providers: [
    {
      type: "customJwt",
      issuer: process.env.AUTH_JWT_ISSUER!,
      jwks: `${process.env.CONVEX_SITE_URL}/.well-known/jwks.json`,
      algorithm: "RS256",
      applicationID: process.env.APPLE_BUNDLE_ID!,
    },
  ],
};
```

`convex/http.ts` exposes:

- `GET /.well-known/jwks.json` — serves the public key as a JWK set.
- `POST /auth/apple/exchange` — verifies Apple identity token + nonce, upserts user, returns `{ sessionToken, refreshToken, sessionExpiresAt, refreshExpiresAt }`.
- `POST /auth/refresh` — verifies refresh JWT, rotates session JWT (and refresh JWT if near expiry).

`convex/lib/jwt.ts` owns `mintSessionTokens`, Apple JWKS fetching/caching, and nonce verification.

`convex/lib/auth.ts` exposes the standard helpers used everywhere in queries/mutations:

```ts
export async function requireUser(ctx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  const userId = identity.subject as Id<"users">;
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("User not found");
  return user;
}
```

Note: `identity.subject` is the Convex `users._id`, because that's what we set as `sub` when minting. **Do not** look up by `tokenIdentifier` here — that field is a Convex Auth concept, not a Custom JWT concept.

## Client side — Swift

Implement `ConvexMobile.AuthProvider` (typealias `T = AppleAuthSession`) with:

- `login(onIdToken:)` — generates raw nonce, SHA-256 hashes it for `request.nonce`, runs `ASAuthorizationController` on the main actor, exchanges the identity token, persists tokens to Keychain, schedules a proactive refresh, calls `onIdToken(sessionToken)`.
- `loginFromCache(onIdToken:)` — silent cold-start path. Reuses session JWT if `> 60s` of life remains, otherwise hits `/auth/refresh` with the stored refresh token. Wipes Keychain + throws `AuthError.notSignedIn` if the refresh token is also expired.
- `logout()` — cancel refresh task, wipe Keychain, call `onIdToken(nil)` so the Convex client stops sending the stale JWT on reconnects.
- `extractIdToken(from:)` — return the session JWT.

Plus `ASAuthorizationControllerDelegate` + `ASAuthorizationControllerPresentationContextProviding` extensions to bridge SIWA's UIKit callbacks back to the async `login()`.

Subtleties that matter (and are easy to break):

- **Nonce:** generate a raw nonce client-side, send `SHA256(rawNonce)` as `request.nonce`, send the **raw** nonce in the exchange body. The server re-derives the hash and compares against the identity token's `nonce` claim. This is the only thing protecting against identity-token replay.
- **Proactive refresh:** schedule a `Task` to refresh ~5 min before `sessionExpiresAt`. This keeps live queries from having to reconnect when the JWT rolls over.
- **`ASAuthorizationController` must run on `@MainActor`.** ConvexMobile's `login()` isn't actor-isolated, so wrap the controller call in `Task { @MainActor in ... }`.
- **Pin the controller.** Apple holds the delegate weakly. Store the active `ASAuthorizationController` on `self` so it can't deallocate mid-flow.
- **Email + fullName are only delivered on the *first* sign-in** with a given Apple ID. Persist them server-side at exchange time; never rely on subsequent SIWA responses to include them.
- **Keychain over UserDefaults.** Both session and refresh tokens are bearer tokens; store both in Keychain. See `KeychainStore` in any of the three reference repos.

## SwiftUI gating

For the auth gate UI pattern (loading → signed-in vs. signed-out switch, error states, retry), skinlytix has the cleanest example: `ios/Skinlytix/Features/AuthGateView.swift` + `AuthenticatedRoot.swift`.

## When to choose this over Clerk / Convex Auth

Pick this pattern when:

- Native iOS-only app (or iOS-first) and the user wants the native Apple sheet, no web fallback, no other providers.
- The user wants to own the user table and the session JWT (e.g. for server-to-server APIs that also need to validate the same JWT).
- App is small enough that adding Clerk's dependency + dashboard surface area isn't worth it.

Pick **Clerk** instead (see `references/clerk.md`) when:

- The app has a web companion that also needs auth.
- The user wants email/password, Google, magic links, or a hosted user dashboard.
- The user wants UI components rather than building the SwiftUI sign-in screen themselves.

Pick **Convex Auth** instead (see `references/convex-auth.md`) when:

- The app is primarily web/React Native with no native iOS surface.
- The user wants OTPs, magic links, or passwords managed by Convex itself.

## Checklist

- [ ] `auth.config.ts` configured with `type: "customJwt"`, RS256, JWKS pointing at our deployment
- [ ] All four env vars set in **both** dev and prod Convex deployments
- [ ] `/auth/apple/exchange`, `/auth/refresh`, and `/.well-known/jwks.json` HTTP routes registered in `convex/http.ts`
- [ ] Apple identity token verification checks `iss`, `aud` (= bundle id), `exp`, signature against Apple's JWKS, AND nonce match
- [ ] Session JWT `sub` = Convex `users._id` (so `identity.subject` is directly usable in `requireUser`)
- [ ] iOS provider hashes the nonce before sending to Apple; sends raw nonce on exchange
- [ ] Session + refresh tokens persisted in Keychain (not UserDefaults)
- [ ] Proactive refresh task scheduled ~5 min before session expiry
- [ ] `loginFromCache` wipes Keychain and throws `notSignedIn` when refresh token is expired
- [ ] `Sign In with Apple` capability added to the Xcode target + provisioning profile
- [ ] Bundle id matches `APPLE_BUNDLE_ID` env var exactly
