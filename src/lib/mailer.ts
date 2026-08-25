import type { FastifyBaseLogger } from "fastify";

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
  /** Plain text is required; a client that cannot render HTML still gets the link. */
  text: string;
  html?: string;
}

export interface Mailer {
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
  send: async ({ to, subject, text }) => {
    log.info(
      { to, subject, body: text },
      "email-not-sent (console mailer — configure a real Mailer for production)"
    );
  },
});
