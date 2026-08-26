import type { FastifyBaseLogger } from "fastify";
import { config } from "../config/index.ts";

/**
 * The whole email surface of this boilerplate, deliberately tiny.
 *
 * Better Auth never sends email itself — it hands you a fully-formed URL and a
 * token in a callback and lets you decide what to do with them (see
 * modules/auth/auth.factory.ts). That means the choice of provider is ours, and
 * the only thing the rest of the code needs to agree on is this interface.
 *
 * Keeping it an interface rather than a concrete Resend/SES/Postmark client is
 * what makes the dev-mode console implementation and the test fake possible
 * without either of them pretending to be a mail server.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  /**
   * Required, never optional. Some clients render text by preference, some
   * users force it, and an HTML-only message scores worse with spam filters.
   * It must carry the same link the HTML does.
   */
  text: string;
  /** Set for real templates; see modules/auth/auth.emails.ts. */
  html?: string;
}

export interface Mailer {
  /**
   * The sender address is the implementation's business, not the caller's —
   * it is transport configuration, and providers differ on whether it is
   * per-message or per-account. Implementations should use
   * `config.auth.emailFrom`.
   */
  send(message: EmailMessage): Promise<void>;
}

/**
 * The default implementation: log the message and move on.
 *
 * A boilerplate that requires an API key before you can register your first
 * user is a boilerplate you cannot run. This makes the verification and reset
 * flows fully exercisable on a fresh clone with no external account — you copy
 * the link out of the terminal.
 *
 * It logs through Fastify's logger rather than console.log for two reasons:
 * the `no-console` lint rule, and so the line carries the same reqId as the
 * request that triggered it.
 */
export const createConsoleMailer = (log: FastifyBaseLogger): Mailer => ({
  send: async ({ to, subject, text, html }) => {
    // The plain-text body is logged, not the HTML: the point of this in
    // development is that you can read the message and click the link out of
    // your terminal, and a wall of table markup defeats that.
    log.info(
      {
        from: config.auth.emailFrom,
        to,
        subject,
        hasHtml: html !== undefined,
        body: text,
      },
      "email-not-sent (console mailer — configure a real Mailer for production)"
    );
  },
});

/**
 * A sketch of what a production implementation looks like — every provider SDK
 * reduces to this shape. Copy it into your project, drop in the SDK, and pass
 * the result where `createConsoleMailer` is used in plugins/auth.ts.
 *
 * ```ts
 * const resendMailer: Mailer = {
 *   send: async ({ to, subject, text, html }) => {
 *     await resend.emails.send({
 *       from: config.auth.emailFrom,
 *       to,
 *       subject,
 *       text,
 *       ...(html === undefined ? {} : { html }),
 *     });
 *   },
 * };
 * ```
 *
 * Two things worth doing there and not here: let a send failure throw (Better
 * Auth logs it and the user can retry), and set the provider's own retry or
 * queue policy — a dropped verification email is an account that never
 * activates.
 */
