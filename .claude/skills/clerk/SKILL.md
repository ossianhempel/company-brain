---
name: clerk
description: Clerk authentication router. Use when user asks about adding authentication, setting up Clerk, custom sign-in flows, Swift or native iOS auth, Next.js patterns, organizations, syncing users, or testing. Automatically routes to the specific skill based on their task.
---

# Clerk Skills Router

## Version Detection

Check `package.json` to determine the Clerk SDK version. This determines which patterns to use:

| Package | Core 2 (LTS until Jan 2027) | Current |
|---------|----------------------------|---------|
| `@clerk/nextjs` | v5–v6 | v7+ |
| `@clerk/react` or `@clerk/clerk-react` | v5–v6 | v7+ |
| `@clerk/expo` or `@clerk/clerk-expo` | v1–v2 | v3+ |
| `@clerk/react-router` | v1–v2 | v3+ |
| `@clerk/tanstack-react-start` | < v0.26.0 | v0.26.0+ |

**Default to current** if the version is unclear or the project is new. Core 2 packages use `@clerk/clerk-react` and `@clerk/clerk-expo` (with `clerk-` prefix); current packages use `@clerk/react` and `@clerk/expo`.

All skills are written for the current SDK. When something differs in Core 2, it's noted inline with `> **Core 2 ONLY (skip if current SDK):**` callouts. The exception is `clerk-custom-ui`, which has separate `core-2/` and `core-3/` directories for custom flow hooks since those APIs are entirely different between versions.

---

## By Task

**Operating the Clerk CLI** → Use `clerk-cli`
- `clerk init`, `clerk env pull`, `clerk apps create/list`, `clerk config patch/put`, `clerk doctor`
- `clerk api` for any Backend or Platform API call (users, orgs, sessions, JWT templates, webhooks, instance config)
- Auth, project linking, agent-mode/sandbox handling
- **Prefer this for any Clerk management or backend-data task** — it replaces dashboard clicking and raw HTTP

**Adding Clerk to your project** → Use `clerk-setup`
- Fallback for frameworks the CLI doesn't cover: iOS Swift, Android, Chrome extension, vanilla JS, Expo
- Migration plans from other auth providers (NextAuth, Supabase, Firebase, Auth0, etc.)
- shadcn/ui theme application
- For CLI-supported frameworks (Next.js, React, Vue, Nuxt, Astro, React Router, TanStack Start, Remix), defer to `clerk-cli`

**Custom sign-in/sign-up UI** → Use `clerk-custom-ui`
- Custom authentication flows with `useSignIn` / `useSignUp` hooks
- Appearance and styling (themes, colors, layout)
- `<Show>` component for conditional rendering

**Advanced Next.js patterns** → Use `clerk-nextjs-patterns`
- Server vs Client auth APIs
- Middleware strategies
- Server Actions, caching
- API route protection

**Webhooks** → Use `clerk-webhooks`
- Real-time events
- Data syncing
- Notifications & integrations

**E2E Testing** → Use `clerk-testing`
- Playwright/Cypress setup
- Auth flow testing
- Test utilities

**Swift / native iOS auth** → Use `clerk-swift`
- Native iOS Swift and SwiftUI projects
- ClerkKit and ClerkKitUI implementation guidance
- Source-driven patterns from `clerk-ios`
- Do not use for Expo or React Native projects

**Backend REST API** → Use `clerk-cli`
- `clerk api ls <keyword>` to discover endpoints
- `clerk api <path>` for authenticated calls with auto key resolution and `--dry-run` safety
- Replaces the previous `clerk-backend-api` skill

## Quick Navigation

If you know your task, you can directly access:
- `/clerk-cli` - Clerk CLI operations + Backend/Platform API
- `/clerk-setup` - Fallback framework setup (iOS, Android, Chrome ext, vanilla JS, Expo) + migrations
- `/clerk-custom-ui` - Custom flows & appearance
- `/clerk-nextjs-patterns` - Next.js patterns
- `/clerk-webhooks` - Webhooks
- `/clerk-testing` - Testing
- `/clerk-swift` - Swift/native iOS

Or describe what you need and I'll recommend the right one.
