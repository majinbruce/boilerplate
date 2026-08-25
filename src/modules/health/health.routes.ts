import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/**
 * Two probes, because an orchestrator asks two different questions.
 *
 * Liveness: is the process alive? It deliberately checks nothing external — if
 * it checked the database, a database blip would make Kubernetes kill every
 * healthy pod at once and turn a small outage into a total one.
 *
 * Readiness: can THIS instance serve traffic right now? It checks dependencies,
 * and a failure removes the pod from the load balancer without restarting it.
 */
const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/live",
    {
      // Health checks fire constantly; counting them against the caller's rate
      // limit would eventually make the probe itself fail.
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        response: {
          200: z.object({ status: z.literal("alive"), uptime: z.number() }),
        },
      },
    },
    async () => ({ status: "alive" as const, uptime: process.uptime() })
  );

  app.get(
    "/ready",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Readiness probe",
        response: {
          200: z.object({
            status: z.enum(["ready", "not ready"]),
            env: z.string(),
            uptime: z.number(),
            checks: z.object({ database: z.enum(["up", "down"]) }),
          }),
          503: z.object({
            status: z.enum(["ready", "not ready"]),
            env: z.string(),
            uptime: z.number(),
            checks: z.object({ database: z.enum(["up", "down"]) }),
          }),
        },
      },
    },
    async (request, reply) => {
      let database: "up" | "down" = "down";

      try {
        await app.db.query("SELECT 1");
        database = "up";
      } catch (err) {
        request.log.error({ err }, "readiness-check-failed");
      }

      const healthy = database === "up";
      reply.code(healthy ? 200 : 503);

      return {
        status: healthy ? ("ready" as const) : ("not ready" as const),
        env: app.config.env,
        uptime: process.uptime(),
        checks: { database },
      };
    }
  );
};

export default healthRoutes;
