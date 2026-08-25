import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { onRequestHookHandler, preHandlerHookHandler } from "fastify";
import { config } from "../config/index.ts";
import { forbidden } from "../lib/errors.ts";

export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

/** Tells TypeScript what request.user actually holds after jwtVerify(). */
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** onRequest hook: verifies the bearer token and populates request.user. */
    authenticate: onRequestHookHandler;
    /** preHandler factory: run *after* authenticate, gates on role. */
    requireRole: (...roles: AuthUser["role"][]) => preHandlerHookHandler;
    signToken: (user: AuthUser) => string;
  }
}

export default fp(
  async (app) => {
    await app.register(fastifyJwt, {
      secret: config.jwt.secret,
      sign: { expiresIn: config.jwt.expiresIn },
    });

    /**
     * Decorated rather than exported, so routes reach it as `app.authenticate`
     * and never import across module boundaries to get it. The Express version
     * of this had to be listed on every single route; here a route group opts
     * in once with `app.addHook("onRequest", app.authenticate)`.
     *
     * jwtVerify throws FST_JWT_* errors that already carry a 401, and the
     * error handler turns them into the standard envelope. Nothing about the
     * token is ever logged.
     */
    app.decorate("authenticate", async function authenticate(request) {
      await request.jwtVerify();
    });

    app.decorate(
      "requireRole",
      (...roles: AuthUser["role"][]): preHandlerHookHandler =>
        async function requireRole(request) {
          if (!roles.includes(request.user.role)) {
            throw forbidden("You do not have permission to perform this action");
          }
        }
    );

    app.decorate("signToken", (user: AuthUser) => app.jwt.sign({ ...user }));
  },
  { name: "auth" }
);
