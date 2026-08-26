# Fastify + TypeScript + PostgreSQL boilerplate

Production-shaped API skeleton: Fastify 5, TypeScript on Node's native type
stripping, Zod for validation _and_ serialization _and_ docs, raw SQL over `pg`.
No ORM, no build step in development, no `tsx`.

Authentication is [Better Auth](https://better-auth.com) 1.7 — email/password
with verification and reset, "Continue with Google", and one session model
served over both httpOnly cookies (browser) and bearer tokens (everything else).
See [How auth works here](#how-auth-works-here).

## Quick start

```bash
docker compose up
```

That is the whole setup. Compose starts Postgres (named volume, healthcheck),
runs the migrations as a one-shot service, and starts the API in watch mode with
your source bind-mounted — edits reload without a rebuild. It reads dev defaults
from the committed `.env.example`, so there is nothing to copy first.

- API: `http://localhost:3000`
- Docs: `http://localhost:3000/docs` (non-production only)
- Probes: `/health/live`, `/health/ready`

**Before you ship anything**, generate a real secret and put it in
`.env.development` (or your platform's env):

```bash
npm run auth:secret        # -> BETTER_AUTH_SECRET
```

Anything you set in `.env.development` overrides the defaults; the file is
gitignored. Google sign-in is optional and off until you add credentials — see
[Google OAuth setup](#google-oauth-setup).

Already using port 5432 or 3000? `PG_PUBLISHED_PORT=5433 PORT=3001 docker compose up`.

### Running without Docker

```bash
npm install
cp .env.example .env.development
docker compose up -d postgres    # or point PG_* at your own database
npm run migrate
npm run dev
```

## Scripts

| Script                | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `npm run dev`         | `node --watch src/server.ts` — Node strips the types itself |
| `npm run build`       | `tsc -p tsconfig.build.json` → `dist/`                      |
| `npm start`           | Runs the compiled output                                    |
| `npm run migrate`     | Applies `db/migrations/*.sql` once each, in order           |
| `npm run auth:secret` | Generates a `BETTER_AUTH_SECRET`                            |
| `npm run auth:schema` | Regenerates Better Auth's SQL after an upgrade — diff it    |
| `npm run typecheck`   | `tsc --noEmit` over `src` and `test`                        |
| `npm test`            | Vitest, using `app.inject()` — no port, no supertest        |
| `npm run lint`        | Type-aware ESLint                                           |

## Layout

```
src/
  config/index.ts        env parsed by Zod at boot; nothing else reads process.env
  lib/                   framework-free helpers (errors, envelope, redaction, mailer)
    auth.ts              CLI + type entrypoint; the running app never imports it
  plugins/               cross-cutting concerns, each wrapped in fp()
    config.ts            decorates app.config
    error-handler.ts     setErrorHandler + setNotFoundHandler
    db.ts                pg Pool, typed query<T>(), withTransaction, onClose
    security.ts          helmet, cors, compress, rate-limit, under-pressure
    auth.ts              Better Auth instance, app.requireAuth, app.requireRole
    swagger.ts           OpenAPI generated from the same Zod schemas
  modules/<feature>/     routes -> service -> repository, one folder per feature
    *.schemas.ts         Zod: validation + serialization + types + docs
    *.repository.ts      SQL and row types
    *.service.ts         business rules, dependencies passed in
    *.routes.ts          schema declarations and thin handlers
    auth.emails.ts       the verification / reset templates (content, not wiring)
  app.ts                 builds the app (does NOT listen)
  server.ts              listens, waits for the DB, handles signals
db/migrations/           plain .sql files
db/init/                 runs once on first Postgres boot (creates app_test)
test/                    app.inject() tests
  integration/           the ones that need a real Postgres
```

## How auth works here

Authentication is [Better Auth](https://better-auth.com) (v1.7), mounted inside
Fastify. If you have not used it before, the one thing to understand is that it
is **not** a middleware you call helpers on — `betterAuth(options)` builds a
self-contained HTTP router with its own endpoints, validation, database access
and cookie handling. `src/modules/auth/auth.factory.ts` is therefore not
configuration _around_ the auth implementation; it **is** the implementation.

### The pieces

**The adapter.** `database: pool` hands Better Auth the application's own `pg`
Pool, which it wraps in Kysely's `PostgresDialect`. That is all the "Postgres
adapter" is — a thin translation from Better Auth's abstract schema to plain
parameterised SQL. It is not an ORM and it does not own a connection: `pg` is a
peer dependency, so it is literally the same driver `plugins/db.ts` already
pools, error-handles and shuts down.

**Plugins.** A Better Auth plugin can add endpoints, tables, request middleware
and client methods. Only one is enabled here: `bearer()`, and it is what makes
the mobile story work (below).

**Sessions.** A session is a **row in `sessions`** holding an opaque token. The
cookie carries that token and nothing else, so every authenticated request is an
indexed lookup. This is the opposite of a self-contained JWT, and it is the
whole reason a session is revocable: delete the row and the next request is a 401. Defaults are 7 days, refreshed at most once a day of use.

`session.cookieCache` is deliberately **off**. It would skip the per-request
lookup by trusting a short-lived signed cookie — a real performance win that
also means a revoked session keeps working until that cookie expires. There is a
test asserting revocation is immediate; turn the cache on when you have measured
that you need it, and expect that test to change.

**Accounts.** `users` is the person; `accounts` is one row per _way of signing
in_. The password hash lives on the `accounts` row with `provider_id =
'credential'`, not on the user — which is exactly why the same person can also
have a Google account attached. Passwords are hashed with **scrypt** by default.

### The four tables

| Table           | Holds                                                           |
| --------------- | --------------------------------------------------------------- |
| `users`         | the person: name, email, `email_verified`, `role`               |
| `sessions`      | one row per active login; the token the cookie/bearer carries   |
| `accounts`      | one row per sign-in method; the scrypt hash lives here          |
| `verifications` | short-lived tokens: verification, reset, and OAuth state + PKCE |

### Protecting a route

Unchanged in shape from what this boilerplate did before, so the scope rule
still holds — declare it once and every route in the scope inherits it:

```ts
const secured: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", app.requireAuth); // authentication
  app.delete("/:id", { preHandler: app.requireRole("admin") }, handler); // authorisation
};
```

Inside a guarded handler, narrow with `requireUser(request)` rather than a
non-null assertion — `request.user` is genuinely `null` on unauthenticated
routes, and two places rely on that.

`request.user` and `request.session` are fully typed, and the types are
**derived from the config** via `typeof auth.$Infer.Session`. Add a field to
`user.additionalFields` and the request types follow with no second edit.

### Cookie and bearer are one session, not two systems

`requireAuth` is a single call:

```ts
const resolved = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
```

That call checks the session cookie, and — because `bearer()` is registered —
also `Authorization: Bearer`. Both carry the same opaque token and resolve to the
**same row** in `sessions`. There is no branch on client type, no second token
format, no refresh-token dance. A test asserts both transports return an
identical session id.

**What a mobile client does differently:** exactly one thing. On sign-in it
reads the `set-auth-token` response header and stores that string itself
(Keychain / Keystore — not `localStorage`), then sends `Authorization: Bearer
<token>` on every request. Same endpoints, same session, same expiry, same
revocation. For native Google sign-in, `POST /api/auth/sign-in/social` also
accepts an `idToken` so the device can skip the browser redirect entirely.

The browser keeps cookies because they are `httpOnly`: an XSS bug cannot read
the session out of them. That protection is unavailable to a token you have to
hand to JavaScript, which is why bearer is the fallback and not the default.

### What the OAuth callback actually does

1. Frontend calls `signIn.social({ provider: "google", callbackURL })`.
2. Backend generates OAuth `state` + a PKCE verifier, **stores them in
   `verifications` along with `callbackURL`**, and 302s to Google.
3. User consents at Google.
4. Google redirects to `/api/auth/callback/google?code=…&state=…`.
5. Backend looks up `state` — this is what rejects a forged or replayed
   callback — and exchanges `code` for tokens **server-side**, so the client
   secret never reaches a browser.
6. Fetches the Google profile, finds-or-creates the `users` row, upserts the
   `accounts` row.
7. Creates a `sessions` row and sets the httpOnly cookie.
8. 302s the browser to the `callbackURL` recovered in step 5.

**Account linking.** Sign up with a password and later use "Continue with
Google" at the same address and you get **one** user with **two** `accounts`
rows. The safety condition is upstream's default and is kept: implicit linking
requires the existing local row to already be email-verified, so an attacker
cannot pre-register an unverified account at your address and have your Google
identity linked into their row.

### Two things that surprise people

**`/api/auth/*` does not use the standard envelope.** Better Auth returns its
own `{ code, message }` shape and the Better Auth client SDK parses exactly
that, so rewriting it would break every SDK method. This is the one documented
exception; everything else in the API, including `GET /api/auth/me`, uses the
envelope.

**Origin headers are required.** Better Auth refuses a state-changing request
that arrives with cookies but no (or an untrusted) `Origin` — that is its CSRF
defence. Browsers always send one; `curl` and test helpers must be told to.
Note that `advanced.disableOriginCheck` is pinned to `false` in the factory
**on purpose**: left unset, Better Auth turns origin validation off whenever
`NODE_ENV=test`, and a security control should not vary by environment.

## Transactional email

Better Auth never sends mail itself — it builds the URL and hands it to a
callback. Everything after that is ours, split in two:

| File                              | Owns                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/lib/mailer.ts`               | the `Mailer` interface and the console dev implementation — _how_ a message is delivered |
| `src/modules/auth/auth.emails.ts` | the verification and reset templates — _what_ the message says and looks like            |

The split is the point: rewording an email should not be a diff against your
auth configuration, and swapping Resend for SES should not touch a template.

**The templates are production-shaped, not placeholders.** Table-based layout
with inline styles (Gmail strips `<style>`; Outlook's renderer predates
flexbox), every colour stated explicitly, a padded `<a>` as the button rather
than an image, a preheader line, and a plain-text alternative that carries the
same link. The raw URL is always printed under the button, because corporate
mail scanners rewrite and strip links and that is the user's only fallback.

No template engine. Two transactional emails do not justify MJML or Handlebars,
and a boilerplate should not pick yours.

Rebranding is `APP_NAME`, plus the `THEME` object at the top of
`auth.emails.ts`. Changing `APP_NAME` is safe at any time — cookie names come
from `cookiePrefix`, which does not derive from it, so a rename does not sign
everyone out.

### Going to production

Implement one method and pass it where `createConsoleMailer(app.log)` is used in
`plugins/auth.ts`:

```ts
const resendMailer: Mailer = {
  send: async ({ to, subject, text, html }) => {
    await resend.emails.send({
      from: config.auth.emailFrom,
      to,
      subject,
      text,
      ...(html === undefined ? {} : { html }),
    });
  },
};
```

The sender address is the implementation's business — it is transport config,
and providers differ on whether it is per-message or per-account. Let a send
failure throw; Better Auth logs it and the user can retry.

> **User input reaches the inbox.** `name` is whatever someone typed at sign-up,
> and with account linking it can arrive in an inbox that is not theirs. Every
> interpolated value is escaped, and there is a test asserting a hostile display
> name is escaped rather than injected. Keep that true if you edit the markup.

## Google OAuth setup

Optional. With no credentials set, the provider simply is not registered and
everything else works.

1. [Google Cloud Console](https://console.cloud.google.com/) → create or pick a
   project.
2. **APIs & Services → OAuth consent screen** — configure it, and add yourself
   under _Test users_ while it is unpublished.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
4. Under **Authorized redirect URIs**, add exactly:

   | Environment | URI                                                |
   | ----------- | -------------------------------------------------- |
   | Local       | `http://localhost:3000/api/auth/callback/google`   |
   | Production  | `https://your-domain.com/api/auth/callback/google` |

   The path is `{BETTER_AUTH_URL}{basePath}/callback/google`. It must match
   character for character — a trailing slash is a different URI.

5. Put the credentials in `.env.development`:

   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

   Both or neither — the config schema rejects one without the other at boot.

6. Make sure `BETTER_AUTH_URL` is the origin you registered. Better Auth builds
   the `redirect_uri` from it, so a wrong value is the classic
   `redirect_uri_mismatch` — and it fails only in the environment that is wrong,
   which is usually production.

Set `FRONTEND_URL` (and `TRUSTED_ORIGINS` if they differ) to wherever the
browser should land afterwards. Every `callbackURL` is validated against
`TRUSTED_ORIGINS`; that check is what stops these endpoints being an open
redirect, so nothing is hardcoded and a split-origin deploy is a config change.

## Migrations

Plain `.sql` files applied once each, in filename order, by
`src/scripts/migrate.ts`. In Docker they run as a one-shot `migrate` service
before the API starts.

```bash
npm run migrate          # apply pending migrations
```

Better Auth's own tables live in `db/migrations/0001_create_auth_tables.sql`.
That file was **generated** and then hand-finished, which is the recommended
loop after a Better Auth upgrade:

```bash
npm run auth:schema      # writes the SQL Better Auth thinks it needs
```

Diff the output against the migration and hand-write a new numbered file for
anything genuinely missing. Deliberately **not** `auth migrate`: it diffs the
live database and records nothing in `schema_migrations`, which would make it a
second, disagreeing source of truth for what has been applied. Generation is
also how the column mapping stays honest — the first run caught two columns
this repo would otherwise have got wrong.

Column names are remapped to snake_case (and `user` → `users`, since `user` is
a reserved word in Postgres) via `modelName`/`fields` in `auth.factory.ts`.
**That mapping and the migration are two halves of one thing** — change a column
in one and you must change it in the other; nothing will tell you they drifted
except `npm run auth:schema`.

## Testing

```bash
npm test
```

Unit tests need nothing. Integration tests (`test/integration/`) run against a
real Postgres — the `app_test` database that `db/init/` creates on first
`docker compose up`. A `globalSetup` migrates and truncates it once per run.

Real Postgres, because the interesting claims are ones a fake cannot settle
honestly: `ON DELETE CASCADE` revoking sessions, the unique index behind the
`23505` → 409 mapping, and Better Auth's own SQL against our column names. A
separate database rather than Testcontainers, because compose already gives you
a server and this needs no Docker socket in CI. Files still run in parallel —
isolation comes from every test minting a random email.

The mailer is injected (`buildTestApp(fakeMailer)`), so verification and reset
links are read out of the fake and followed exactly as a user would. That is
what the `Mailer` interface is for.

## The two rules the structure encodes

**1. `fp()` means shared, plain means private.**
`app.register(plugin)` runs the plugin inside a _child_ instance, so anything it
decorates or hooks dies with that child. `fastify-plugin` opts out of that, which
is right for a connection pool and wrong for a route group's auth hook. Every
file in `plugins/` is wrapped; nothing in `modules/` is.

**2. Scope is how you authorise, not repetition.**
`user.routes.ts` declares `addHook("onRequest", app.requireAuth)` exactly once,
inside a nested `register`. Every route added to that scope inherits it — including
routes added later by someone who never read the file. Forgetting to protect an
endpoint is not a mistake you can make from inside the scope.

## Why Zod instead of Joi

One schema produces four things: request validation, the response serializer,
the TypeScript type, and the OpenAPI page. The serializer only emits fields the
schema names, so a password hash that slips into a handler's return value is
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

The one exception is `/api/auth/*`, which returns Better Auth's own shape
because its client SDK depends on it — see
[How auth works here](#two-things-that-surprise-people).

## Error mapping

Handled centrally in `plugins/error-handler.ts`: Zod validation → 400, Postgres
`23505` → 409, `23503` → 400, `23502`/`22P02` → 400, `AppError` → its own status
(this is how `requireAuth`'s 401 and `requireRole`'s 403 are reported), oversized
body → 413, bad content type → 415. Anything unrecognised keeps its 500 and its
message is withheld in production.
