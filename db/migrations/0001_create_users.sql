-- pgcrypto gives gen_random_uuid(). UUID primary keys because a sequential
-- integer id leaks how many users exist and how fast they are signing up.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);

-- Partial unique index, not a plain UNIQUE constraint: soft-deleted rows keep
-- their email, and without the WHERE clause that address could never be
-- reused. This is the index that produces the 23505 the API turns into a 409.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_key
  ON users (LOWER(email))
  WHERE deleted_at IS NULL;

-- Matches the list query's ORDER BY created_at DESC over live rows only.
CREATE INDEX IF NOT EXISTS users_created_at_idx
  ON users (created_at DESC)
  WHERE deleted_at IS NULL;
