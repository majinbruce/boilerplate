import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { config } from "../config/index.ts";

/**
 * Migrations without an ORM, in one file.
 *
 * Each .sql file in db/migrations runs once, in filename order, inside a
 * transaction, and its name is recorded. Re-running is a no-op. That is
 * genuinely all a migration tool has to do — the rest of what an ORM's
 * migration system offers is generating the SQL, which is the part we are
 * deliberately writing by hand.
 */

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../db/migrations");

const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

const log = (message: string) => process.stdout.write(`${message}\n`);

const run = async () => {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations"
    );
    const applied = new Set(rows.map((row) => row.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      log("No pending migrations.");
      return;
    }

    for (const file of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");

      // DDL is transactional in Postgres, so a migration that fails halfway
      // leaves nothing behind — including its own bookkeeping row.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`applied  ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration failed: ${file}`, { cause: err });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
};

try {
  await run();
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
