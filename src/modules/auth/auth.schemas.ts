import { z } from "zod";

/**
 * The role vocabulary, defined here because auth owns it — the factory's
 * `additionalFields.role` and the database CHECK constraint are the other two
 * places it appears, and all three must agree.
 */
export const userRole = z.enum(["user", "admin"]);

/**
 * What GET /api/auth/me returns.
 *
 * Everything Better Auth's own endpoints return is shaped by Better Auth (see
 * the note in auth.routes.ts). This route is ours, so it uses the house
 * envelope and the house serializer — which also means a field that is not
 * named here cannot leak, whatever the session object happens to carry.
 */
export const sessionUserDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: userRole,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const meDtoSchema = z.object({
  user: sessionUserDtoSchema,
  session: z.object({
    id: z.uuid(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  }),
});

export type SessionUserDto = z.infer<typeof sessionUserDtoSchema>;
