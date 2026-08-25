-- Better Auth's core schema: the four tables that make up an identity.
--
-- This file is the other half of the modelName/fields mapping in
-- src/modules/auth/auth.factory.ts. If you change a column name here, change it
-- there too — nothing else will tell you they have drifted.
--
-- It was produced by `npx auth@latest generate --config src/lib/auth.ts` and
-- then hand-finished (see the notes below). Regenerate after a Better Auth
-- upgrade and diff the output rather than transcribing the schema by hand: the
-- first generation caught two columns this file would otherwise have got wrong.

-- gen_random_uuid(). advanced.database.generateId is set to "uuid" so Better
-- Auth's primary keys look like every other id in this database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The person. One row per human, regardless of how many ways they can sign in.
CREATE TABLE IF NOT EXISTS users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  -- Better Auth lowercases the address before it ever reaches SQL, so a plain
  -- UNIQUE is enough here — no LOWER() expression index needed.
  email          TEXT        NOT NULL UNIQUE,
  email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  image          TEXT,
  -- Hand-added: the generator emits a bare nullable TEXT because
  -- `additionalFields` applies its default in JavaScript. The NOT NULL, the
  -- default and the CHECK are this codebase's convention, and they mean the
  -- database enforces the invariant even for a hand-written INSERT.
  role           TEXT        NOT NULL DEFAULT 'user'
                             CHECK (role IN ('user', 'admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per active login. `token` is the opaque value carried by the session
-- cookie (and, for non-browser clients, by the bearer header) — it is looked up
-- on every authenticated request, which is exactly what makes a session
-- revocable: DELETE the row and the next request is a 401.
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per *way of signing in*. This is the table that makes account linking
-- work: a user who signed up with a password and later used "Continue with
-- Google" has one users row and two accounts rows.
--
-- The password hash lives HERE, on the provider_id = 'credential' row, not on
-- the user — to Better Auth a password is just another linked credential.
CREATE TABLE IF NOT EXISTS accounts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- issuer + account_id is the stable provider-side identity; provider_id is
  -- which of our configured providers produced it.
  issuer                   TEXT        NOT NULL,
  account_id               TEXT        NOT NULL,
  provider_id              TEXT        NOT NULL,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope                    TEXT,
  -- scrypt hash for provider_id = 'credential'; NULL for OAuth accounts.
  password                 TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Short-lived single-use tokens: email verification, password reset, and the
-- OAuth state + PKCE verifier for an in-flight Google sign-in. Rows are
-- consumed on use and expire on their own.
CREATE TABLE IF NOT EXISTS verifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT        NOT NULL,
  value      TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts (user_id);
CREATE INDEX IF NOT EXISTS verifications_identifier_idx ON verifications (identifier);

-- The uniqueness that stops one provider identity being attached to two users.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_issuer_account_id_uidx
  ON accounts (issuer, account_id);

-- Matches the users list query's ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
