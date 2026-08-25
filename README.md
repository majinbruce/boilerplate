# Fastify + TypeScript + PostgreSQL boilerplate

Production-shaped API skeleton: Fastify 5, TypeScript on Node's native type
stripping, Zod for validation _and_ serialization _and_ docs, raw SQL over `pg`.
No ORM, no build step in development, no `tsx`.

## Quick start

```bash
npm install
cp .env.example .env.development          # set JWT_SECRET (32+ chars)
docker compose up -d postgres             # or point PG_* at your own database
npm run migrate
npm run dev
```

- API: `http://localhost:3000`
- Docs: `http://localhost:3000/docs` (non-production only)
- Probes: `/health/live`, `/health/ready`

## Scripts

| Script              | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `npm run dev`       | `node --watch src/server.ts` — Node strips the types itself |
| `npm run build`     | `tsc -p tsconfig.build.json` → `dist/`                      |
| `npm start`         | Runs the compiled output                                    |
| `npm run migrate`   | Applies `db/migrations/*.sql` once each, in order           |
| `npm run typecheck` | `tsc --noEmit` over `src` and `test`                        |
| `npm test`          | Vitest, using `app.inject()` — no port, no supertest        |
| `npm run lint`      | Type-aware ESLint                                           |

## Layout

```
src/
  config/index.ts        env parsed by Zod at boot; nothing else reads process.env
  lib/                   framework-free helpers (errors, response envelope, redaction)
  plugins/               cross-cutting concerns, each wrapped in fp()
    config.ts            decorates app.config
    error-handler.ts     setErrorHandler + setNotFoundHandler
    db.ts                pg Pool, typed query<T>(), withTransaction, onClose
    security.ts          helmet, cors, compress, rate-limit, under-pressure
    auth.ts              @fastify/jwt, app.authenticate, app.requireRole
    swagger.ts           OpenAPI generated from the same Zod schemas
  modules/<feature>/     routes -> service -> repository, one folder per feature
    *.schemas.ts         Zod: validation + serialization + types + docs
    *.repository.ts      SQL and row types
    *.service.ts         business rules, dependencies passed in
    *.routes.ts          schema declarations and thin handlers
  app.ts                 builds the app (does NOT listen)
  server.ts              listens, waits for the DB, handles signals
db/migrations/           plain .sql files
test/                    app.inject() tests
```

## The two rules the structure encodes

**1. `fp()` means shared, plain means private.**
`app.register(plugin)` runs the plugin inside a _child_ instance, so anything it
decorates or hooks dies with that child. `fastify-plugin` opts out of that, which
is right for a connection pool and wrong for a route group's auth hook. Every
file in `plugins/` is wrapped; nothing in `modules/` is.

**2. Scope is how you authorise, not repetition.**
`user.routes.ts` declares `addHook("onRequest", app.authenticate)` exactly once,
inside a nested `register`. Every route added to that scope inherits it — including
routes added later by someone who never read the file. Forgetting to protect an
endpoint is not a mistake you can make from inside the scope.

## Why Zod instead of Joi

One schema produces four things: request validation, the response serializer,
the TypeScript type, and the OpenAPI page. The serializer only emits fields the
schema names, so a `password_hash` that slips into a handler's return value is
dropped on the way out — a whole class of leak becomes structurally impossible.

## Why no ORM

The SQL is the source of truth and the row `type` is the hand-written contract
for what it returns; `db.query<UserRow>(sql, params)` types every result from
there. Everything is parameterised — string interpolation of user input into SQL
is the one rule with no exceptions. Migrations are plain `.sql` files applied by
`src/scripts/migrate.ts` (~80 lines, transactional, idempotent).

## Response envelope

```jsonc
{ "statusCode": 0,  "message": "...", "data": {} }             // success
{ "statusCode": 0,  "message": "...", "data": [], "meta": {} } // paginated
{ "statusCode": -1, "message": "...", "requestId": "...", "details": [] } // failure
```

`details` is always `[{ field, message }]`, and a validation failure reports every
bad field at once rather than one per round trip. Every response also carries an
`x-request-id` header matching the `reqId` in the logs.

## Error mapping

Handled centrally in `plugins/error-handler.ts`: Zod validation → 400, Postgres
`23505` → 409, `23503` → 400, `23502`/`22P02` → 400, `FST_JWT_*` → 401, oversized
body → 413, bad content type → 415. Anything unrecognised keeps its 500 and its
message is withheld in production.
