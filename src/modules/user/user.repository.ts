import type { Database } from "../../plugins/db.ts";
import { config } from "../../config/index.ts";
import type { UserDto } from "./user.schemas.ts";

/**
 * Row types are `type` aliases, not interfaces, on purpose: pg's generic is
 * constrained to QueryResultRow (an index signature) and TypeScript only gives
 * type aliases an implicit index signature.
 *
 * This is the whole "no ORM" position in one file — the SQL is the source of
 * truth and the row type is the hand-written contract for what it returns.
 * db.query<UserRow>() then makes every downstream property access checked.
 */
export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  created_at: Date;
  updated_at: Date | null;
};

export type UserWithSecretRow = UserRow & { password_hash: string };

// Table names are built from config, never from user input.
const USERS = `${config.db.schema}.users`;

/**
 * Every query is parameterised ($1, $2, ...). String interpolation of user
 * input into SQL is the one rule with no exceptions here.
 */

export const findById = async (db: Database, id: string): Promise<UserRow | null> => {
  const sql = `
    SELECT id, name, email, role, created_at, updated_at
    FROM ${USERS}
    WHERE id = $1 AND deleted_at IS NULL`;

  const { rows } = await db.query<UserRow>(sql, [id]);
  return rows[0] ?? null;
};

/** Returns the password hash too — only the login path may call this. */
export const findByEmailWithSecret = async (
  db: Database,
  email: string
): Promise<UserWithSecretRow | null> => {
  const sql = `
    SELECT id, name, email, role, password_hash, created_at, updated_at
    FROM ${USERS}
    WHERE email = $1 AND deleted_at IS NULL`;

  const { rows } = await db.query<UserWithSecretRow>(sql, [email.toLowerCase()]);
  return rows[0] ?? null;
};

/**
 * COUNT(*) OVER() returns the total alongside the page in one round trip,
 * instead of a second COUNT query that can disagree with the first.
 */
export const list = async (
  db: Database,
  { limit, offset, search }: { limit: number; offset: number; search?: string }
): Promise<{ rows: UserRow[]; total: number }> => {
  const sql = `
    SELECT id, name, email, role, created_at, updated_at,
           COUNT(*) OVER() AS total_count
    FROM ${USERS}
    WHERE deleted_at IS NULL
      AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2`;

  const { rows } = await db.query<UserRow & { total_count: string }>(sql, [
    limit,
    offset,
    search ?? null,
  ]);

  const first = rows[0];
  const total = first ? Number(first.total_count) : 0;

  return { rows, total };
};

export const insert = async (
  db: Database,
  {
    name,
    email,
    passwordHash,
    role,
  }: { name: string; email: string; passwordHash: string; role: "user" | "admin" }
): Promise<UserRow> => {
  const sql = `
    INSERT INTO ${USERS} (name, email, password_hash, role)
    VALUES ($1, $2, $3, $4)
    RETURNING id, name, email, role, created_at, updated_at`;

  const { rows } = await db.query<UserRow>(sql, [
    name,
    email.toLowerCase(),
    passwordHash,
    role,
  ]);

  // RETURNING on a successful INSERT always yields exactly one row; the
  // non-null assertion is the one place that fact is asserted.
  return rows[0]!;
};

/**
 * COALESCE lets one statement handle a partial update — absent fields are
 * passed as null and leave the existing column untouched.
 */
export const update = async (
  db: Database,
  id: string,
  { name, email }: { name?: string; email?: string }
): Promise<UserRow | null> => {
  const sql = `
    UPDATE ${USERS}
    SET name       = COALESCE($2, name),
        email      = COALESCE($3, email),
        updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING id, name, email, role, created_at, updated_at`;

  const { rows } = await db.query<UserRow>(sql, [
    id,
    name ?? null,
    email?.toLowerCase() ?? null,
  ]);

  return rows[0] ?? null;
};

// Soft delete — history stays intact and the row can be restored.
export const softDelete = async (db: Database, id: string): Promise<string | null> => {
  const sql = `
    UPDATE ${USERS}
    SET deleted_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING id`;

  const { rows } = await db.query<{ id: string }>(sql, [id]);
  return rows[0]?.id ?? null;
};

/**
 * The boundary between "database row" and "API resource". Keeping them apart
 * means a column rename is a one-line change here instead of a breaking API
 * change, and snake_case never escapes this file.
 */
export const toDto = (row: UserRow): UserDto => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at?.toISOString() ?? null,
});
