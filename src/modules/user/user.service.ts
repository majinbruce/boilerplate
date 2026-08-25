import bcrypt from "bcryptjs";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../plugins/db.ts";
import { conflict, notFound, unauthorized } from "../../lib/errors.ts";
import * as repo from "./user.repository.ts";
import type {
  CreateUserBody,
  ListUsersQuery,
  UpdateUserBody,
  UserDto,
} from "./user.schemas.ts";

/**
 * Services take their dependencies as an argument instead of importing a
 * singleton pool. That is what makes them testable in isolation, and passing
 * `request.log` means every line a service writes carries the reqId of the
 * request that caused it.
 */
export interface Ctx {
  db: Database;
  log: FastifyBaseLogger;
}

const SALT_ROUNDS = 12;

/**
 * Business rules live here, not in the route. The route only declares its
 * schemas and formats the response; this decides what is allowed.
 */
export const createUser = async (
  { db, log }: Ctx,
  { name, email, password, role }: CreateUserBody
): Promise<UserDto> => {
  const existing = await repo.findByEmailWithSecret(db, email);

  if (existing) throw conflict("A user with this email already exists");

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const row = await repo.insert(db, { name, email, passwordHash, role });

  log.info({ userId: row.id }, "user-created");

  return repo.toDto(row);
};

export const getUser = async ({ db }: Ctx, id: string): Promise<UserDto> => {
  const row = await repo.findById(db, id);

  // Missing rows are an expected outcome, so throw an operational error rather
  // than returning null and making every caller check.
  if (!row) throw notFound("User not found");

  return repo.toDto(row);
};

export const listUsers = async (
  { db }: Ctx,
  { page, limit, search }: ListUsersQuery
): Promise<{ data: UserDto[]; page: number; limit: number; total: number }> => {
  const offset = (page - 1) * limit;

  const { rows, total } = await repo.list(db, {
    offset,
    limit,
    ...(search === undefined ? {} : { search }),
  });

  return { data: rows.map(repo.toDto), page, limit, total };
};

export const updateUser = async (
  { db, log }: Ctx,
  id: string,
  { name, email }: UpdateUserBody
): Promise<UserDto> => {
  if (email) {
    const owner = await repo.findByEmailWithSecret(db, email);

    // Allow re-submitting the same email; block taking someone else's.
    if (owner && owner.id !== id) {
      throw conflict("A user with this email already exists");
    }
  }

  const row = await repo.update(db, id, {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
  });

  if (!row) throw notFound("User not found");

  log.info({ userId: id }, "user-updated");

  return repo.toDto(row);
};

export const deleteUser = async ({ db, log }: Ctx, id: string): Promise<void> => {
  const deletedId = await repo.softDelete(db, id);

  if (!deletedId) throw notFound("User not found");

  log.info({ userId: id }, "user-deleted");
};

/**
 * Verifies credentials for the login route. The generic message is deliberate:
 * distinguishing "no such user" from "wrong password" hands an attacker a
 * free account-enumeration oracle.
 */
export const verifyCredentials = async (
  { db, log }: Ctx,
  email: string,
  password: string
) => {
  const row = await repo.findByEmailWithSecret(db, email);

  // Comparing against a dummy hash when the user is absent keeps the timing of
  // both branches roughly equal.
  const hash =
    row?.password_hash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
  const matches = await bcrypt.compare(password, hash);

  if (!row || !matches) {
    log.warn({ email }, "login-failed");
    throw unauthorized("Invalid email or password");
  }

  return { id: row.id, email: row.email, role: row.role };
};
