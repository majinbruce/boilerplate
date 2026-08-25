import { z } from "zod";
import { userRole } from "../auth/auth.schemas.ts";

/**
 * One schema per shape, and every route reuses these. A single Zod object is
 * simultaneously:
 *   1. the request validator,
 *   2. the response serializer (fields not listed here are DROPPED),
 *   3. the TypeScript type, via z.infer,
 *   4. the OpenAPI documentation.
 *
 * Note what is NOT here any more: there is no create-user body and no password
 * field of any kind. Accounts come into existence through Better Auth's
 * /api/auth/sign-up/email or through Google, and the password hash lives on the
 * accounts table. This module is now read-and-administer over the user table,
 * not a second way to make an account.
 */

export { userRole };

const name = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name cannot be more than 100 characters");

export const userIdParamSchema = z.object({
  id: z.uuid("User ID must be a valid UUID"),
});

/**
 * Email is deliberately absent.
 *
 * Changing an address by UPDATE would walk straight past Better Auth's
 * verification step, and email is the key implicit account linking trusts — so
 * a silent email change is an account-takeover primitive. Email changes belong
 * to Better Auth's own change-email flow (`user.changeEmail`, off by default),
 * not to a generic admin PATCH.
 */
export const updateUserBodySchema = z
  .object({
    name: name.optional(),
    role: userRole.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export const listUsersQuerySchema = z.object({
  // Query strings are always strings; coerce or every comparison downstream is
  // subtly wrong.
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a caller cannot request the whole table in one query.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
});

/** What the API returns. */
export const userDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: userRole,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UserDto = z.infer<typeof userDtoSchema>;
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
