import type { Database } from "../../plugins/db.ts";
import { config } from "../../config/index.ts";
import type { UserDto } from "./user.schemas.ts";

/**
 * Row types are `type` aliases, not interfaces, on purpose: pg's generic is
 * constrained to QueryResultRow (an index signature) and TypeScript only gives
 * type aliases an implicit index signature.
 *
 * The table these read is owned by Better Auth — db/migrations/0001 creates it
 * and Better Auth writes to it during sign-up. Reading it with plain SQL is
 * fine and is the point of sharing one database; what this module must NOT do
 * is write anything Better Auth has invariants about (email, and the password
 * that lives over on `accounts`).
 */
export type UserRow = {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  role: "user" | "admin";
  created_at: Date;
  updated_at: Date;
};

// Table names are built from config, never from user input.
const USERS = `${config.db.schema}.users`;

const COLUMNS = "id, name, email, email_verified, image, role, created_at, updated_at";

/**
 * Every query is parameterised ($1, $2, ...). String interpolation of user
 * input into SQL is the one rule with no exceptions here.
 */

export const findById = async (db: Database, id: string): Promise<UserRow | null> => {
  const sql = `SELECT ${COLUMNS} FROM ${USERS} WHERE id = $1`;

  const { rows } = await db.query<UserRow>(sql, [id]);
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
    SELECT ${COLUMNS},
           COUNT(*) OVER() AS total_count
    FROM ${USERS}
    WHERE ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%')
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

/**
 * COALESCE lets one statement handle a partial update — absent fields are
 * passed as null and leave the existing column untouched.
 */
export const update = async (
  db: Database,
  id: string,
  { name, role }: { name?: string; role?: "user" | "admin" }
): Promise<UserRow | null> => {
  const sql = `
    UPDATE ${USERS}
    SET name       = COALESCE($2, name),
        role       = COALESCE($3, role),
        updated_at = NOW()
    WHERE id = $1
    RETURNING ${COLUMNS}`;

  const { rows } = await db.query<UserRow>(sql, [id, name ?? null, role ?? null]);

  return rows[0] ?? null;
};

/**
 * A hard delete, where this used to be a soft one.
 *
 * Soft delete and Better Auth do not mix: its session lookup does not know
 * about a deleted_at column, so a "deleted" user would keep authenticating
 * with an existing session and could still sign in. The ON DELETE CASCADE on
 * sessions and accounts means removing the row also revokes every session and
 * unlinks every provider, which is the behaviour deleting an account should
 * have had anyway.
 */
export const remove = async (db: Database, id: string): Promise<string | null> => {
  const sql = `DELETE FROM ${USERS} WHERE id = $1 RETURNING id`;

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
  emailVerified: row.email_verified,
  image: row.image,
  role: row.role,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
