import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { errorEnvelope, ok, successEnvelope } from "../../lib/api-response.ts";
import * as userService from "../user/user.service.ts";

const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Password is required"),
});

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/login",
    {
      // A per-route override of the global limit. Credential stuffing is a
      // volume attack, so the login endpoint gets its own much tighter budget.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Exchange credentials for a JWT",
        body: loginBodySchema,
        response: {
          200: successEnvelope(z.object({ token: z.string(), expiresIn: z.string() })),
          401: errorEnvelope,
          429: errorEnvelope,
        },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      const { email, password } = request.body;

      const user = await userService.verifyCredentials(ctx, email, password);
      const token = app.signToken(user);

      request.log.info({ userId: user.id }, "login-succeeded");

      return ok({ token, expiresIn: app.config.jwt.expiresIn }, "Login successful");
    }
  );
};

export default authRoutes;
