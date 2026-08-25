import fp from "fastify-plugin";
import pg from "pg";
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "../config/index.ts";

const { Pool } = pg;

/**
 * The typed query helper. `db.query<UserRow>(sql, params)` gives back rows
 * typed as UserRow — the row shape is asserted once, at the call site that
 * wrote the SQL, instead of being inferred by an ORM that has to be told about
 * the schema twice.
 */
export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  waitForConnection(): Promise<void>;
  pool: PgPool;
}

/**
 * Declaration merging: this teaches TypeScript that every FastifyInstance —
 * and therefore `request.server`, and `this` inside a handler — has `.db`.
 * Without it, `app.db` is a compile error even though it exists at runtime.
 */
declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

const SLOW_QUERY_MS = 500;
const MAX_CONNECT_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/**
 * fp() is what makes `app.db` visible to the whole app.
 *
 * A plain plugin runs inside a child instance, so anything it decorates dies
 * with that child. fp() says "run me against the parent" — which is exactly
 * right for a shared connection pool and exactly wrong for, say, a route
 * group's auth hook.
 */
export default fp(
  async (app) => {
    // A pool, never a single client — one client serialises every request and
    // dies permanently on a dropped connection.
    const pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      max: config.db.max,
      idleTimeoutMillis: config.db.idleTimeoutMillis,
      connectionTimeoutMillis: config.db.connectionTimeoutMillis,
    });

    // Idle-client errors must not crash the process; the pool replaces the client.
    pool.on("error", (err) => {
      app.log.error({ err }, "Unexpected error on idle PostgreSQL client");
    });

    /**
     * Logs slow queries so a regression shows up before users report it.
     * Parameters are never logged — they routinely contain personal data.
     */
    const query = async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<QueryResult<T>> => {
      const startedAt = process.hrtime.bigint();

      try {
        const result = await pool.query<T>(sql, params as unknown[]);
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        if (durationMs > SLOW_QUERY_MS) {
          app.log.warn(
            {
              durationMs: Number(durationMs.toFixed(2)),
              rows: result.rowCount,
              sql: oneLine(sql),
            },
            "slow-query"
          );
        }

        return result;
      } catch (err) {
        app.log.error({ err, sql: oneLine(sql) }, "query-failed");
        throw err;
      }
    };

    /**
     * Runs a set of statements in a single transaction, rolling back on any
     * throw and always releasing the client.
     *
     *   await app.db.withTransaction(async (client) => {
     *     await client.query("INSERT ...", [a]);
     *     await client.query("UPDATE ...", [b]);
     *   });
     */
    const withTransaction = async <T>(
      fn: (client: PoolClient) => Promise<T>
    ): Promise<T> => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    };

    /**
     * Retries on boot because the database container is often not ready yet
     * when the app starts. This throws instead of exiting the process: the
     * decision to die belongs to server.ts, so tests can build an app without
     * a database and still exercise validation, auth and error handling.
     */
    const waitForConnection = async (): Promise<void> => {
      for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt += 1) {
        try {
          const client = await pool.connect();
          try {
            await client.query("SELECT 1");
          } finally {
            client.release();
          }
          app.log.info("Connected to PostgreSQL");
          return;
        } catch (err) {
          app.log.error(
            { err, attempt, of: MAX_CONNECT_RETRIES },
            "PostgreSQL connection failed"
          );

          if (attempt === MAX_CONNECT_RETRIES) {
            throw new Error("Could not connect to PostgreSQL", { cause: err });
          }

          await sleep(RETRY_DELAY_MS);
        }
      }
    };

    app.decorate("db", { query, withTransaction, waitForConnection, pool });

    /**
     * The pool now closes itself. app.close() runs every plugin's onClose hook
     * in reverse registration order, so server.ts never learns that a database
     * exists — this is the payoff of owning a resource inside a plugin.
     */
    app.addHook("onClose", async () => {
      await pool.end();
      app.log.info("PostgreSQL pool closed");
    });
  },
  { name: "db" }
);
