import { buildApp, type App } from "../src/app.ts";

/**
 * Builds an app that never listens on a port. app.inject() pushes a real
 * request through the entire lifecycle — hooks, validation, serialization,
 * error handler — in memory, so these tests exercise the same code path
 * production does without a socket, a port, or supertest.
 *
 * The pg pool connects lazily, so everything that fails before touching the
 * database (validation, auth, 404s) is testable with no database running.
 */
export const buildTestApp = async (): Promise<App> => {
  const app = await buildApp();
  await app.ready();
  return app;
};
