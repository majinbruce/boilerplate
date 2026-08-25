import path from "node:path";
import process from "node:process";
import { config as loadEnvFile } from "dotenv";
import { z } from "zod";

/**
 * Configuration is parsed once, at boot, into a frozen typed object. Nothing
 * else in the app reads process.env — so a missing or malformed variable is a
 * startup crash with a precise message, never a mysterious `undefined` three
 * hours into a deploy.
 *
 * This replaces dotenv-safe: the schema below IS the contract that .env.example
 * used to express, except it also coerces types and carries defaults.
 */

const VALID_ENVS = ["development", "production", "test"] as const;

// Bracket access because `noPropertyAccessFromIndexSignature` is on: process.env
// is an index signature, and dot access hides the fact that the key may not exist.
const nodeEnv = process.env["NODE_ENV"] ?? "development";

if (!VALID_ENVS.includes(nodeEnv as (typeof VALID_ENVS)[number])) {
  throw new Error(
    `Invalid NODE_ENV "${nodeEnv}". Expected one of: ${VALID_ENVS.join(", ")}`
  );
}

// Real environment variables always win over the file, which is what container
// platforms (ECS, Cloud Run, k8s) inject. The file is a local-dev convenience.
loadEnvFile({
  path: path.resolve(process.cwd(), `.env.${nodeEnv}`),
  quiet: true,
});

/**
 * `z.coerce` is deliberate: every value out of process.env is a string, and
 * without coercion `PORT` would be "3000" and every numeric comparison in the
 * app would be subtly wrong.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(VALID_ENVS).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),

  CORS_ORIGINS: z.string().default("*"),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  // No default. A boilerplate that ships with a fallback JWT secret is how
  // "change-me" ends up signing production tokens.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("1d"),

  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_USER: z.string().min(1),
  PG_PASSWORD: z.string(),
  PG_DATABASE: z.string().min(1),
  PG_SCHEMA: z.string().default("public"),
  PG_POOL_MAX: z.coerce.number().int().positive().default(20),
  PG_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Written straight to stderr: the logger itself depends on this config, so
  // it does not exist yet at this point in the boot sequence.
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  process.stderr.write(`Invalid environment configuration:\n${details}\n`);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === "production";

export const config = {
  env: env.NODE_ENV,
  isProduction,
  isDevelopment: env.NODE_ENV === "development",
  isTest: env.NODE_ENV === "test",

  server: {
    port: env.PORT,
    host: env.HOST,
    bodyLimit: env.BODY_LIMIT_BYTES,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  },

  logLevel: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),

  // "*" means reflect any origin; anything else is an explicit allow-list.
  corsOrigins: env.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },

  db: {
    host: env.PG_HOST,
    port: env.PG_PORT,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    schema: env.PG_SCHEMA,
    max: env.PG_POOL_MAX,
    idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
  },
} as const;

export type Config = typeof config;
