import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import underPressure from "@fastify/under-pressure";
import { config } from "../config/index.ts";

/**
 * Everything that used to be a stack of app.use() lines. Order still matters —
 * Fastify runs these as lifecycle hooks in registration order — but it is now
 * declared once, in one file, instead of being spread across app.js.
 */
export default fp(
  async (app) => {
    await app.register(helmet, {
      // The Swagger UI page needs inline styles/scripts; the API itself serves
      // JSON, where CSP does nothing. Turning it off only for the docs route
      // would be stricter, but this keeps the boilerplate honest about it.
      contentSecurityPolicy: config.isProduction,
    });

    await app.register(cors, {
      origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
      credentials: true,
    });

    await app.register(compress, {
      // Below ~1KB, compression costs more CPU than it saves bytes.
      threshold: 1024,
      global: true,
    });

    /**
     * Rate limiting is global here and can be tightened per-route with
     * `config: { rateLimit: { max: 5, timeWindow: "1 minute" } }` — the login
     * route does exactly that.
     */
    await app.register(rateLimit, {
      max: config.rateLimit.max,
      timeWindow: config.rateLimit.windowMs,
      // Authenticated callers are limited per user, anonymous ones per IP.
      keyGenerator: (request) => request.user?.id ?? request.ip,
      errorResponseBuilder: (request, context) => ({
        statusCode: -1,
        message: `Rate limit exceeded. Retry in ${context.after}.`,
        requestId: request.id,
      }),
    });

    /**
     * Load shedding. When the event loop is already too far behind, returning
     * 503 immediately is kinder than accepting work the process cannot finish:
     * a queue that never drains turns one slow endpoint into a dead instance.
     */
    await app.register(underPressure, {
      maxEventLoopDelay: 1_000,
      maxHeapUsedBytes: 1_000_000_000,
      maxRssBytes: 1_000_000_000,
      retryAfter: 50,
      exposeStatusRoute: false,
    });
  },
  { name: "security" }
);
