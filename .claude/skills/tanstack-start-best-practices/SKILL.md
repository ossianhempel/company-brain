---
name: tanstack-start-best-practices
description: "Build/review TanStack Start apps. Triggers: TanStack Start, @tanstack/react-start/router, createServerFn, middleware, server routes, auth, deployment, Next.js/Remix migration."
license: MIT
metadata:
  source: official-tanstack-docs
  updated: "2026-06-08"
---

# TanStack Start Best Practices

Use this skill for TanStack Start apps. Prefer the official docs and the installed package version over memory when exact APIs matter. If the project has TanStack Intent mappings, load those package-shipped skills too; this skill is the durable profile-level checklist for web app work.

## First Checks

Before editing:

1. Check `package.json` for the installed TanStack packages and versions.
2. Check the route structure, usually under `src/routes`.
3. Find the router setup, usually `src/router.tsx`, `src/client.tsx`, and `src/ssr.tsx`.
4. Check whether route generation is committed or generated during dev/build. Do not hand-edit generated route trees.
5. Identify the deployment target before changing server behavior; Start can run on several runtimes, and server APIs, environment access, and adapter details can differ.

## Source Priority

Use these sources in order:

1. Installed package docs or package-shipped skills under `node_modules`.
2. Official TanStack Start docs for the app's framework and version.
3. Official examples from the TanStack Router repo.
4. Existing project patterns.

Avoid third-party boilerplate skills unless the user explicitly asks for that stack. Many community Start skills bundle opinionated choices such as Cloudflare, Drizzle, shadcn/ui, or a specific auth library; do not treat those as TanStack defaults.

## Core Model

TanStack Start is built on TanStack Router plus server-capable primitives.

- Keep routing type-safe and route-owned. Put route loading, validation, and route-specific server calls near the route that owns them.
- Use file-based routes when the project is already using them. Keep filenames and route boundaries aligned with TanStack Router conventions.
- Use search-param validation for user-controlled query strings. Do not parse complex route state ad hoc in components.
- Treat server functions as RPC-like boundaries for app operations, not as a replacement for every local function.
- Use server routes for HTTP endpoints, webhooks, and non-page responses.
- Use middleware for cross-cutting request behavior such as auth context, headers, redirects, and shared validation.

## Server Functions

Use server functions for typed server work called from the app.

- Define inputs explicitly and validate externally controlled data.
- Keep server functions small and operation-focused.
- Keep secrets, database clients, and privileged APIs on the server side.
- Return serializable data. Avoid leaking raw database rows if they contain private fields.
- Handle auth and authorization inside the server boundary, even when the caller UI is hidden behind an authenticated route.
- Do not move high-frequency client-only interactions into server functions.

When data can be loaded as part of route loading, prefer that over a client effect that fetches after paint.

## Data Loading

Prefer route-aware loading and cache-aware data fetching.

- Load route-critical data through route loaders or Start server functions rather than `useEffect`.
- Parallelize independent server work.
- Keep pending and error states local to the route segment that owns the data.
- When using TanStack Query, hydrate/dehydrate in the established project pattern and keep query keys stable and specific.
- Do not duplicate the same fetch in a route loader and again in a component unless there is a clear cache boundary.

## Routing And Layouts

- Use layout routes for shared shells, auth gates, and common data.
- Keep redirects and not-found behavior close to the route layer.
- Use typed params and validated search state instead of stringly typed helper code.
- Prefer route-level boundaries over global catch-all error handling for recoverable page errors.
- Do not hand-write links with raw URLs when the router provides typed navigation helpers already used by the project.

## Auth

TanStack Start provides auth server primitives, but auth product choice is app-specific.

- Check the existing auth provider before adding new auth code.
- Put session lookup and request context in middleware or the project's established server context path.
- Re-check authorization in server functions and server routes.
- Keep cookies and tokens HTTP-only where possible.
- For Clerk, Better Auth, WorkOS, Supabase, or Convex Auth, use the matching repo/profile skill when available.

## Middleware

Use middleware for request-wide behavior.

- Good fits: session loading, auth redirects, request IDs, security headers, locale detection, and shared context.
- Bad fits: route-specific business logic, database writes hidden from route/server-function callers, or component state.
- Keep middleware order explicit and easy to audit.
- Make redirects intentional; avoid surprising middleware redirects from API/server routes unless that is the documented app behavior.

## Server Routes

Use server routes for HTTP surfaces.

- Good fits: webhooks, health checks, Open Graph images, RSS/metadata, file responses, and external API callbacks.
- Validate method, headers, params, and body.
- Return proper HTTP status codes.
- Keep webhook verification close to the route handler.
- Do not use page route loaders for external webhook/API traffic.

## Deployment

Before changing runtime-sensitive code, identify the target:

- Node server
- Bun
- Cloudflare Workers
- Netlify
- Vercel
- Railway
- Docker or custom server

Then verify:

- Environment variable access pattern
- Request/Response runtime support
- Streaming support
- Asset/CDN URL behavior
- Adapter configuration
- Build and preview commands

Do not assume Next.js deployment behavior applies to Start.

## Migration From Next.js Or Remix

When migrating:

- Map pages/routes to TanStack Router route files deliberately.
- Replace framework-specific server actions, loaders, metadata, middleware, and API routes with Start/Router equivalents.
- Revisit cache semantics instead of copying `fetch` cache options or Next-specific revalidation patterns.
- Remove `use client` / server component assumptions unless the installed Start version and project configuration explicitly support a similar boundary.
- Keep the migration incremental when possible: route, data loading, auth, deployment, then cleanup.

## Testing And Verification

For non-trivial changes:

1. Run typecheck.
2. Run the route generator or build command if the project uses generated route trees.
3. Run tests around changed routes/server functions.
4. Start the dev server and click through changed pages when UI behavior changes.
5. For server routes, test real requests with representative headers/body.

If exact commands are not obvious, inspect `package.json` scripts first.

## Official References

- TanStack Start React Getting Started: `https://tanstack.com/start/v0/docs/framework/react/getting-started`
- TanStack Start docs: `https://tanstack.com/start/latest`
- TanStack Intent Agent Skills docs: `https://tanstack.com/ai/latest/docs/getting-started/agent-skills`
- TanStack Intent registry: `https://tanstack.com/intent/registry`
- `@tanstack/react-start` registry entry: `https://tanstack.com/intent/registry/%40tanstack__react-start`
- `@tanstack/start-client-core` registry entry: `https://tanstack.com/intent/registry/%40tanstack__start-client-core`
