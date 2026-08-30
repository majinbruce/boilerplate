/**
 * FIRST, and it has to stay first.
 *
 * Sentry instruments `http` and `pg` by patching them as they are loaded, so it
 * only sees anything if it initialises before those modules exist. ESM
 * evaluates imports depth-first in declaration order, so this line — and only
 * this line being above the others — is what guarantees that. Moving it down
 * does not break the build or fail a test; it quietly costs you request context
 * on every error report.
 */
import { captureFatal, flushSentry } from "./instrument.ts";

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
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

  // The drain is part of shutdown but not part of closing, so the budget is the
  // sum: SHUTDOWN_TIMEOUT_MS keeps meaning "how long app.close() gets".
  const forceExit = setTimeout(() => {
    app.log.error("Shutdown timed out — forcing exit");
    process.exit(1);
  }, config.server.shutdownDrainMs + config.server.shutdownTimeoutMs);

  forceExit.unref();

  try {
    /**
     * Stop reporting ready, then wait, and only then close.
     *
     * A load balancer finds out this instance is going away by polling
     * /health/ready, and it polls on an interval — so between SIGTERM and the
     * next poll it is still sending new requests here. Closing immediately
     * means those arrive at a socket that is already refusing: connection reset
     * for the user, 502 in the proxy log, on every single deploy.
     *
     * So the order is: fail readiness, give the balancer long enough to notice
     * and take this instance out of rotation (SHUTDOWN_DRAIN_MS — set it to a
     * couple of poll intervals), and then close. app.close() still waits for
     * everything already in flight, so nothing in progress is dropped either.
     */
    app.lifecycle.beginDraining();

    if (config.server.shutdownDrainMs > 0) {
      app.log.info(
        { drainMs: config.server.shutdownDrainMs },
        "draining — /health/ready now reports 503, still serving in-flight requests"
      );
      await sleep(config.server.shutdownDrainMs);
    }

    await app.close();
    await flushSentry();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "Error during shutdown");
    await flushSentry();
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
  // Report before dying, or the one class of error nobody is watching for is
  // also the one that never reaches the dashboard. captureFatal resolves
  // immediately when Sentry is not configured.
  void captureFatal(err).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  app.log.fatal({ err: reason }, "Unhandled rejection — exiting");
  void captureFatal(reason)
    .then(() => shutdown("unhandledRejection"))
    .finally(() => process.exit(1));
});

try {
  await app.listen({ port: config.server.port, host: config.server.host });
} catch (err) {
  app.log.error({ err }, "Failed to start server");
  process.exit(1);
}
