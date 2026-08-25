import type { FastifyRequest } from "fastify";
import type { AuthUser } from "../plugins/auth.ts";
import { unauthorized } from "./errors.ts";

/**
 * Narrows `request.user` from `AuthUser | null` to `AuthUser`.
 *
 * `request.user` has to be nullable, because it genuinely is null on every
 * unauthenticated request and two places read it that way (the error handler's
 * log line and the rate limiter's key). But inside a handler that sits behind
 * `app.requireAuth`, it is never null — and expressing that with a `!` would be
 * asserting something the compiler cannot check, which is exactly the kind of
 * lie that survives a later refactor moving the route out of the guarded scope.
 *
 * So the check is real. If the hook is ever removed, this throws a 401 instead
 * of dereferencing null — the same shape as the `if (!row) throw notFound()`
 * pattern the repositories already use.
 */
export const requireUser = (request: FastifyRequest): AuthUser => {
  if (!request.user) throw unauthorized("Authentication required");
  return request.user;
};
