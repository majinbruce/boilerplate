import { z } from "zod";

/**
 * One schema per shape, and every route reuses these. A single Zod object is
 * simultaneously:
 *   1. the request validator,
 *   2. the response serializer (fields not listed here are DROPPED, which is
 *      why a password_hash cannot leak by accident),
 *   3. the TypeScript type, via z.infer,
 *   4. the OpenAPI documentation.
 *
 * That is the whole reason for moving off Joi: Joi could only do (1).
 */

export const userRole = z.enum(["user", "admin"]);

const name = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name cannot be more than 100 characters");

const email = z.email("Please provide a valid email address").max(255);

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password cannot be more than 128 characters")
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    "Password must contain an uppercase letter, a lowercase letter and a number"
  );

export const userIdParamSchema = z.object({
  id: z.uuid("User ID must be a valid UUID"),
});

export const createUserBodySchema = z.object({
  name,
  email,
  password,
  role: userRole.default("user"),
});

/**
 * `.refine` replaces Joi's `.min(1)` on the object: an empty PATCH body is a
 * client bug, and silently doing nothing hides it.
 */
export const updateUserBodySchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
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

/** What the API returns. Note there is no password field of any kind here. */
export const userDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: userRole,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().nullable(),
});

export type UserDto = z.infer<typeof userDtoSchema>;
export type CreateUserBody = z.infer<typeof createUserBodySchema>;
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
