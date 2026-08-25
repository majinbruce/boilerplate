import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../plugins/db.ts";
import { notFound } from "../../lib/errors.ts";
import * as repo from "./user.repository.ts";
import type { ListUsersQuery, UpdateUserBody, UserDto } from "./user.schemas.ts";

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

/**
 * Business rules live here, not in the route. The route only declares its
 * schemas and formats the response; this decides what is allowed.
 *
 * There is no createUser and no verifyCredentials any more: both belonged to
 * the hand-rolled JWT flow, and both are now Better Auth's job. Nothing in this
 * file hashes, compares or even sees a password.
 */

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
  { name, role }: UpdateUserBody
): Promise<UserDto> => {
  const row = await repo.update(db, id, {
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role }),
  });

  if (!row) throw notFound("User not found");

  log.info({ userId: id, role }, "user-updated");

  return repo.toDto(row);
};

export const deleteUser = async ({ db, log }: Ctx, id: string): Promise<void> => {
  const deletedId = await repo.remove(db, id);

  if (!deletedId) throw notFound("User not found");

  // Worth an explicit log line: the cascade also destroyed this user's sessions
  // and unlinked their providers.
  log.info({ userId: id }, "user-deleted (sessions and linked accounts cascaded)");
};
