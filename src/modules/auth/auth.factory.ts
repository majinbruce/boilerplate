import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { config } from "../../config/index.ts";
import type { Mailer } from "../../lib/mailer.ts";

/**
 * ============================================================================
 * The one place every Better Auth option lives.
 * ============================================================================
 *
 * A short orientation, because none of this looks like the rest of the app.
 *
 * Better Auth is not a middleware you mount and then call helpers on. Calling
 * `betterAuth(options)` builds a self-contained HTTP router: it owns its own
 * routes (/sign-in/email, /callback/google, /get-session, ...), its own request
 * validation, its own database access and its own cookie handling. What we
 * mount in Fastify (see auth.routes.ts) is a single catch-all that forwards to
 * it. So this options object is not configuration around our code — it *is*
 * the auth implementation, and everything below is a decision.
 *
 * The pieces referenced here:
 *
 *   - the adapter: passing a `pg.Pool` as `database` makes Better Auth wrap it
 *     in Kysely's PostgresDialect. It is not an ORM layer — it is a thin
 *     translation from Better Auth's abstract schema to plain parameterised
 *     SQL over the pool we already own.
 *
 *   - plugins: a Better Auth plugin can add endpoints, database tables, request
 *     middleware and client methods. `bearer()` is a small one — it teaches the
 *     session resolver to also read `Authorization: Bearer`, which is the
 *     entire reason our mobile story is not a second auth system.
 *
 *   - sessions: a row in `sessions` holding an opaque token. The cookie carries
 *     that token and nothing else, so every request is a database lookup and
 *     revocation is immediate. This is the opposite of a self-contained JWT,
 *     and it is why deleting a session actually logs someone out.
 */

/**
 * Only the four methods the factory actually calls. Narrower than
 * FastifyBaseLogger on purpose: it lets lib/auth.ts — the entrypoint the
 * Better Auth CLI imports, where no Fastify instance exists — satisfy this
 * with four no-ops instead of faking a whole logger.
 */
export type AuthLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;

export interface AuthDeps {
  /**
   * The application's pool, not a private one. Better Auth declares `pg` as a
   * peer dependency, so this is literally the same driver the repositories use:
   * one pool to size, one place that logs connection errors, one shutdown path.
   */
  pool: Pool;
  mailer: Mailer;
  log: AuthLogger;
}

/**
 * A factory rather than a module-level `betterAuth({...})` call, so that the
 * mailer and the pool are injected the same way services take a `Ctx`. That is
 * what lets the tests supply a fake mailer and read the verification token out
 * of it instead of running a mail server.
 */
export const createAuth = ({ pool, mailer, log }: AuthDeps) =>
  betterAuth({
    appName: "api",

    /** The adapter. See the note above — this is the whole Postgres setup. */
    database: pool,

    secret: config.auth.secret,

    /**
     * Better Auth builds absolute URLs from these two: the Google redirect URI,
     * the verification link, the reset link. Getting baseURL wrong is the
     * classic `redirect_uri_mismatch`, and it fails only in the environment
     * whose value is wrong — which is usually production.
     */
    baseURL: config.auth.baseUrl,
    basePath: config.auth.basePath,

    /**
     * The open-redirect guard. Any callbackURL / errorCallbackURL a client asks
     * to be sent to after sign-in or verification is checked against this list.
     * Env-driven, so a split-origin deploy adds an origin here instead of
     * changing code.
     */
    trustedOrigins: config.auth.trustedOrigins,

    /* ---- Method 1: email + password ------------------------------------- */
    emailAndPassword: {
      enabled: true,

      /**
       * Passwords are hashed with scrypt by default — a memory-hard KDF, and a
       * deliberate upgrade over the bcrypt this boilerplate used to call by
       * hand. The hash lives in `accounts.password` on the row whose
       * provider_id is "credential", NOT on the user: to Better Auth a password
       * is just one more linked account, which is exactly why the same user can
       * also have a Google account attached.
       */
      minPasswordLength: 8,
      maxPasswordLength: 128,

      requireEmailVerification: config.auth.requireEmailVerification,
      autoSignIn: true,

      /**
       * A password reset is a strong signal that the old sessions are not
       * trusted — "someone else may be signed in as me" is the usual reason a
       * user resets. Defaults to false upstream; on by default here.
       */
      revokeSessionsOnPasswordReset: true,

      sendResetPassword: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          subject: "Reset your password",
          text: `Reset your password with this link:\n\n${url}\n\nIf you did not request this, ignore this email.`,
        });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      /** Straight into a session on verification — one less login for the user. */
      autoSignInAfterVerification: true,

      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          subject: "Verify your email address",
          text: `Confirm your email address with this link:\n\n${url}`,
        });
      },
    },

    /* ---- Method 2: Google ----------------------------------------------- */
    /**
     * Registered only when both credentials are present, so a fresh clone runs
     * with email/password alone and no Google Cloud project. The config module
     * already rejects one credential without the other.
     */
    socialProviders: config.auth.google
      ? {
          google: {
            clientId: config.auth.google.clientId,
            clientSecret: config.auth.google.clientSecret,
            /**
             * Forces the account chooser instead of silently reusing whichever
             * Google account the browser last used — the single most confusing
             * thing about OAuth on a shared machine.
             */
            prompt: "select_account",
          },
        }
      : {},

    /* ---- Schema mapping -------------------------------------------------- */
    /**
     * Better Auth's defaults are camelCase columns on tables named `user`,
     * `session`, `account`, `verification`. Two problems: it would be the only
     * camelCase in a snake_case database, and `user` is a reserved word in
     * Postgres (it works only because the query builder quotes it, and every
     * hand-written join would need `"user"` forever).
     *
     * `modelName` renames the table, `fields` maps a logical field to a column.
     * The mapping is invisible above this file — code still says `emailVerified`
     * — and db/migrations/0001_create_users.sql is its other half. The two must
     * agree; that is the cost of this decision.
     */
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        /**
         * The app-level role, carried on the user row and therefore present on
         * every resolved session — which is what `app.requireRole()` reads.
         *
         * `input: false` is the important flag: it means the field is never
         * accepted from a request body. Without it, `POST /sign-up/email` with
         * `{"role":"admin"}` would be a self-service privilege escalation.
         */
        role: {
          type: ["user", "admin"],
          /**
           * `required: true` alongside `input: false` is the combination that
           * makes `request.user.role` a plain "user" | "admin" instead of
           * `| null | undefined`. It is honest rather than convenient: the
           * column is NOT NULL, and because the value is server-owned with a
           * default, it is always populated on create — the field is required
           * of the *database*, never of the caller.
           */
          required: true,
          defaultValue: "user",
          input: false,
        },
      },
    },

    session: {
      modelName: "sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },

      expiresIn: config.auth.session.expiresIn,
      /**
       * A sliding window: a session in active use is extended at most once per
       * `updateAge`, so an active user is not logged out mid-week while an
       * abandoned session still expires on schedule.
       */
      updateAge: config.auth.session.updateAge,

      /**
       * `cookieCache` is deliberately NOT enabled.
       *
       * It skips the per-request database read by trusting a short-lived signed
       * cookie, which is a real performance win — but it also means a revoked
       * session keeps working until that cookie expires. Instant revocation is
       * worth more than a saved indexed lookup in a boilerplate. Turn it on
       * here when you have measured that you need it.
       */
    },

    account: {
      modelName: "accounts",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },

      accountLinking: {
        enabled: true,
        /**
         * Signing up with a password and later using "Continue with Google" at
         * the same address gives ONE user with TWO account rows, rather than a
         * duplicate account and a confused user.
         *
         * The safety condition is upstream's and we keep its default: implicit
         * linking requires the existing local row to already be email-verified.
         * Otherwise an attacker could pre-register an unverified account at
         * your address and have your Google identity linked into their row.
         */
        trustedProviders: ["google"],
      },
    },

    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },

    /* ---- Transport ------------------------------------------------------- */
    advanced: {
      database: {
        /**
         * "uuid" makes Better Auth use `gen_random_uuid()` on Postgres, so its
         * primary keys look like every other id in this database instead of
         * being random opaque strings in a TEXT column.
         */
        generateId: "uuid",
      },

      useSecureCookies: config.auth.cookie.secure,

      /**
       * Pinned to false ON PURPOSE — do not delete this line as redundant.
       *
       * Left unset, Better Auth derives it as `isTest() ? true : false`, and
       * isTest() is just `NODE_ENV === "test"`. So the default quietly turns
       * OFF origin validation — the check that rejects a state-changing request
       * carrying cookies from an untrusted origin, and the one that stops
       * callbackURL being an open redirect — in any process started with
       * NODE_ENV=test.
       *
       * That is convenient for suites that do not want to send an Origin
       * header, and it is exactly the wrong trade here: it means the CSRF
       * behaviour could not be tested, and a misconfigured NODE_ENV would
       * silently disable a security control. Setting it explicitly makes the
       * rule identical in every environment; the test helpers send a real
       * Origin header, as a browser would.
       */
      disableOriginCheck: false,

      /**
       * httpOnly is the whole point of the cookie path: the session token is
       * unreadable from JavaScript, so an XSS bug cannot exfiltrate it. That is
       * the security difference between this and a token in localStorage, and
       * the reason cookies stay the default for the browser.
       *
       * Defaults target the same-origin VPS deploy (one proxy, `/` and `/api`).
       * Split origins are `COOKIE_SAME_SITE=none` + `COOKIE_SECURE=true`.
       */
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.auth.cookie.secure,
        sameSite: config.auth.cookie.sameSite,
        path: "/",
        ...(config.auth.cookie.domain === undefined
          ? {}
          : { domain: config.auth.cookie.domain }),
      },
    },

    /**
     * Better Auth's own limiter, kept in addition to @fastify/rate-limit.
     *
     * They are not redundant: Fastify sees one catch-all route and can only
     * apply one budget to every auth operation, and that budget has to stay
     * loose because the frontend polls /get-session. This one is path-aware
     * inside Better Auth's router, which is the granularity that credential
     * stuffing and reset-link spraying actually need.
     *
     * Storage is in-memory, which is correct for the single-instance VPS this
     * targets. Multiple instances want `storage: "database"` (plus the
     * rateLimit table) or a secondary store, or each instance enforces its own
     * share of the limit.
     */
    rateLimit: {
      /**
       * Off in tests only. The limits below are deliberately tight enough that
       * a suite creating a dozen accounts would trip them, and a test suite
       * fighting the rate limiter tests the rate limiter rather than the thing
       * it meant to. Upstream's own default is production-only; this keeps it
       * on in development too, so a misconfiguration shows up before deploy.
       */
      enabled: !config.isTest,
      storage: "memory",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 3 },
      },
    },

    /**
     * `bearer()` is what makes one session model serve both clients.
     *
     * With it registered, a successful sign-in also returns the session token
     * in a `set-auth-token` response header, and every subsequent
     * `Authorization: Bearer <token>` is resolved against the SAME `sessions`
     * row the cookie would have matched. There is no second token type, no
     * refresh-token dance and no parallel store — a mobile client differs only
     * in where it keeps the string.
     */
    plugins: [bearer()],

    logger: {
      /**
       * Better Auth logs through our Pino instance rather than stdout, so its
       * output is structured, level-filtered and carries the same fields as
       * every other line in the app.
       */
      disabled: false,
      log: (level, message, ...args) => {
        const line = { scope: "better-auth", args };
        if (level === "error") log.error(line, message);
        else if (level === "warn") log.warn(line, message);
        else if (level === "debug") log.debug(line, message);
        else log.info(line, message);
      },
    },
  });

/** The concrete instance type, used for the Fastify decorator and request types. */
export type Auth = ReturnType<typeof createAuth>;
