import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  errorEnvelope,
  ok,
  paginated,
  paginatedEnvelope,
  successEnvelope,
} from "../../lib/api-response.ts";
import * as userService from "./user.service.ts";
import {
  createUserBodySchema,
  listUsersQuerySchema,
  updateUserBodySchema,
  userDtoSchema,
  userIdParamSchema,
} from "./user.schemas.ts";

const userEnvelope = successEnvelope(userDtoSchema);
const commonErrors = { 400: errorEnvelope, 401: errorEnvelope, 500: errorEnvelope };

/**
 * Everything in here is behind a bearer token. The hook is declared ONCE, and
 * every route added to this scope inherits it — including routes added months
 * from now by someone who never reads this comment. That is the difference
 * from listing `authMiddleware` on each Express route: there, forgetting it is
 * a silent public endpoint; here, forgetting it is impossible.
 */
const securedUserRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/",
    {
      schema: {
        tags: ["users"],
        summary: "List users",
        security: [{ bearerAuth: [] }],
        querystring: listUsersQuerySchema,
        response: { 200: paginatedEnvelope(userDtoSchema), ...commonErrors },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      const { data, ...meta } = await userService.listUsers(ctx, request.query);

      return paginated(data, meta, "Users retrieved successfully");
    }
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["users"],
        summary: "Get a user by id",
        security: [{ bearerAuth: [] }],
        params: userIdParamSchema,
        response: { 200: userEnvelope, 404: errorEnvelope, ...commonErrors },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      const user = await userService.getUser(ctx, request.params.id);

      return ok(user, "User retrieved successfully");
    }
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["users"],
        summary: "Update a user",
        security: [{ bearerAuth: [] }],
        params: userIdParamSchema,
        body: updateUserBodySchema,
        response: {
          200: userEnvelope,
          404: errorEnvelope,
          409: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      const user = await userService.updateUser(ctx, request.params.id, request.body);

      return ok(user, "User updated successfully");
    }
  );

  app.delete(
    "/:id",
    {
      // Authentication came from the scope's hook; authorisation is per-route,
      // and runs at preHandler — after validation, so an admin check never
      // burns CPU on a request that was malformed anyway.
      preHandler: app.requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Soft-delete a user (admin only)",
        security: [{ bearerAuth: [] }],
        params: userIdParamSchema,
        response: {
          200: successEnvelope(z.null()),
          403: errorEnvelope,
          404: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      await userService.deleteUser(ctx, request.params.id);

      return ok(null, "User deleted successfully");
    }
  );
};

const userRoutes: FastifyPluginAsyncZod = async (app) => {
  // Public: this is how an account comes into existence.
  app.post(
    "/",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["users"],
        summary: "Create a user",
        body: createUserBodySchema,
        response: { 201: userEnvelope, 409: errorEnvelope, ...commonErrors },
      },
    },
    async (request, reply) => {
      const ctx = { db: app.db, log: request.log };
      const user = await userService.createUser(ctx, request.body);

      reply.code(201);
      return ok(user, "User created successfully");
    }
  );

  await app.register(securedUserRoutes);
};

export default userRoutes;
