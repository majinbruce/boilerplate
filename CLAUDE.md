# Fastify + TypeScript + PostgreSQL boilerplate

Cloned as the starting point for new projects. Keep these rules intact when
adding features; `README.md` has the long-form reasoning behind each one.

## Commands

- `npm run dev` — Node runs `.ts` directly (type stripping), no tsx/ts-node
- `npm run typecheck` — `tsc --noEmit`; run after any series of edits
- `npm run test:unit` — `app.inject()`, **no database required**
- `npm run test:integration` — needs Postgres up (`docker compose up -d`)
- `npm run lint` / `npm run lint:fix`
- `npm run db:generate` — generate a migration after editing `src/db/schema.ts`

Before calling a change done: `npm run typecheck && npm run lint && npm run test:unit`.

## Conventions that differ from the obvious default

- **Relative imports carry the `.ts` extension** (`./user.service.ts`), not `.js`
  and not extensionless. `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
  handle the build.
- **No enums, namespaces, or constructor parameter properties** — Node's type
  stripping cannot erase them.
- **`import type` is required** for type-only imports (`verbatimModuleSyntax`).
- `exactOptionalPropertyTypes` is on: pass an optional field by spreading
  (`...(x === undefined ? {} : { x })`), never as an explicit `undefined`.
- `noUncheckedIndexedAccess` is on: index access yields `T | undefined`.
- `no-console` is an ESLint error. Log through `request.log` / `app.log`.
- Prettier: 90 columns, double quotes, ES5 trailing commas.

## Architectural rules

**1. `fp()` means shared, plain means private.**
Everything in `src/plugins/` is wrapped in `fastify-plugin` so its decorators
reach the root instance. Nothing in `src/modules/` is wrapped — each route file
gets a child scope. Do not wrap a route plugin.

**2. Authorize by scope, not by repetition.**
Declare `app.addHook("onRequest", app.requireAuth)` once inside a nested
`register`, and every route in that scope inherits it. Never add a per-route
auth check where a scope would do. Per-route `preHandler: app.requireRole(...)`
is for *authorization* on top of that scope.

**3. Only `src/config/index.ts` reads `process.env`.**
Everything else imports `config`. Adding a variable means adding it to the Zod
schema there, to `.env.example`, and to `.env.test` if tests need it.

**4. `src/db/schema.ts` is the single table definition.**
Drizzle queries, migrations, and Better Auth all read it. Better Auth owns the
`users`/`sessions`/`accounts` tables — read them freely, but never write `email`
or anything on `accounts` outside Better Auth's own flows.

**5. Modules are `routes -> service -> repository`.**
Routes declare schemas and format responses. Services hold business rules and
take deps as a `Ctx` argument (never import a singleton pool). Repositories hold
Drizzle queries and a `toDto` mapper. Use the `new-module` skill to scaffold one.

**6. Zod schemas are the response serializer.**
A field absent from the response schema is *dropped* from the payload. If a
value is missing from a response, check the schema before debugging the handler.

**7. Errors: throw the helpers in `src/lib/errors.ts`** (`notFound`, `badRequest`,
`conflict`, …). The error handler plugin renders the envelope. Return
`ok(data, message)` / `paginated(...)` from `src/lib/api-response.ts` on success.

## Security invariants — do not relax without being asked

- `role` is writable only through the admin-guarded `PATCH /:id`. Self-service
  bodies must not contain it, and the service for them must not accept it.
- Listing users is admin-only; the rows carry email addresses.
- Update bodies use `z.strictObject` so an unknown key is a 400, not a silent
  strip. Keep new update schemas strict.
- Never interpolate user input into SQL. Escape LIKE metacharacters (`%`, `_`,
  `\`) when building patterns — see `escapeLikePattern` in `user.repository.ts`.
