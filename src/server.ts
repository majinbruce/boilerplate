import process from "node:process";
import { buildApp } from "./app.ts";
import { config } from "./config/index.ts";

const app = await buildApp();

/**
 * Fail fast on boot. The pool itself connects lazily, so without this the first
 * user request would be the thing that discovers the database is unreachable —
 * and a deploy would go green on a broken instance.
 */
try {
  await app.pg.waitForConnection();
} catch (err) {
  app.log.fatal({ err }, "Database is mandatory — refusing to start");
  await app.close();
  process.exit(1);
}

/**
 * Fastify's close() already runs every plugin's onClose hook (which is where
 * the pg pool shuts itself down) and waits for in-flight requests, so graceful
 * shutdown is mostly just calling it. The hard timeout stays: it guarantees the
 * process dies even if a socket refuses to.
 */
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    app.log.error("Shutdown timed out — forcing exit");
    process.exit(1);
  }, config.server.shutdownTimeoutMs);

  forceExit.unref();

  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * The process is in an unknown state after an uncaught exception, so log and
 * exit; a supervisor (k8s, ECS, systemd, pm2) is expected to restart it. A
 * rejected promise gets the same treatment but goes through shutdown first, so
 * in-flight requests still get their responses.
 */
process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  app.log.fatal({ err: reason }, "Unhandled rejection — exiting");
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});

try {
  await app.listen({ port: config.server.port, host: config.server.host });
} catch (err) {
  app.log.error({ err }, "Failed to start server");
  process.exit(1);
}
