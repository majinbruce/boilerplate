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
 * `z.coerce.boolean()` is the wrong tool for environment variables: it applies
 * JavaScript truthiness, so the string "false" coerces to `true` and a flag you
 * explicitly turned off silently stays on. Parsing the literal instead means a
 * typo ("FALSE", "0", "no") is a boot-time error rather than a surprise.
 */
const envBoolean = z.enum(["true", "false"]).transform((value) => value === "true");

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

  /* ---- Better Auth ------------------------------------------------------ */

  // Signs session tokens and encrypts stored OAuth tokens. No default, on
  // purpose: a boilerplate that ships with a fallback secret is how "change-me"
  // ends up signing production sessions. Generate one with `npm run auth:secret`.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),

  /**
   * The public origin THIS API is reachable at. Better Auth builds the Google
   * redirect URI from it, so if it is wrong you get `redirect_uri_mismatch` in
   * production and nowhere else. It must match the origin registered in the
   * Google Cloud Console exactly.
   */
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),

  // Where the browser is sent after verification / reset / OAuth. The frontend
  // passes the actual callbackURL per request; this is the origin we trust and
  // the fallback the docs tell it to use.
  FRONTEND_URL: z.url().default("http://localhost:3001"),

  // Comma separated. Defaults to FRONTEND_URL, which is the same-origin case.
  TRUSTED_ORIGINS: z.string().optional(),

  // Both or neither — enforced below. Absent means the Google provider is not
  // registered at all, so a fresh clone runs without any Google setup.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // Seconds. 7 days, refreshed once a day of use.
  AUTH_SESSION_EXPIRES_IN_S: z.coerce.number().int().positive().default(604_800),
  AUTH_SESSION_UPDATE_AGE_S: z.coerce.number().int().nonnegative().default(86_400),

  AUTH_REQUIRE_EMAIL_VERIFICATION: envBoolean.default(true),

  // Absent means "secure in production, plain in development", which is what
  // you want locally over http://.
  COOKIE_SECURE: envBoolean.optional(),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  COOKIE_DOMAIN: z.string().min(1).optional(),

  EMAIL_FROM: z.email().default("no-reply@example.com"),

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

/**
 * Cross-field rules. These are the combinations that are individually valid but
 * jointly broken — the kind that otherwise surface as a browser silently
 * dropping a cookie, or as an OAuth error only in production.
 */
const envSchemaWithRules = envSchema
  .refine((env) => Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET), {
    path: ["GOOGLE_CLIENT_SECRET"],
    message:
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or both left unset",
  })
  .refine(
    // Browsers ignore SameSite=None unless Secure is also set, so this pair
    // produces a session that silently never persists. Fail at boot instead.
    (env) =>
      env.COOKIE_SAME_SITE !== "none" ||
      (env.COOKIE_SECURE ?? env.NODE_ENV === "production"),
    {
      path: ["COOKIE_SAME_SITE"],
      message: "COOKIE_SAME_SITE=none requires COOKIE_SECURE=true",
    }
  );

const parsed = envSchemaWithRules.safeParse(process.env);

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

  auth: {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,

    /**
     * Not an env var on purpose. This string appears in three places that must
     * agree: the Fastify prefix in app.ts, Better Auth's own router, and the
     * redirect URI registered with Google. Making it configurable would let
     * them drift, and the failure mode is an OAuth error in production only.
     */
    basePath: "/api/auth",

    frontendUrl: env.FRONTEND_URL,

    /**
     * Every callbackURL / errorCallbackURL a client asks to be redirected to is
     * checked against this list, which is what stops the auth endpoints from
     * being an open redirect. Same-origin deploys need only the frontend.
     */
    trustedOrigins: (env.TRUSTED_ORIGINS ?? env.FRONTEND_URL)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    session: {
      expiresIn: env.AUTH_SESSION_EXPIRES_IN_S,
      updateAge: env.AUTH_SESSION_UPDATE_AGE_S,
    },

    requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,

    // `null`, not `undefined` — an absent provider is a real state the factory
    // branches on, and null makes that check explicit at the call site.
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,

    cookie: {
      secure: env.COOKIE_SECURE ?? isProduction,
      sameSite: env.COOKIE_SAME_SITE,
      // Spread rather than `undefined`: `exactOptionalPropertyTypes` treats an
      // absent key and a key set to undefined as different types.
      ...(env.COOKIE_DOMAIN === undefined ? {} : { domain: env.COOKIE_DOMAIN }),
    },

    emailFrom: env.EMAIL_FROM,
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
