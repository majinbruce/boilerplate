/**
 * Sanitises a `?next=` parameter before it is used as a redirect target.
 *
 * The sign-in page reads where to go back to from the query string, which is
 * attacker-controlled by definition — a link like
 * `/sign-in?next=https://evil.example` is the entire open-redirect bug, and it
 * is worth more than usual here because the page it decorates is the one where
 * people type passwords.
 *
 * The rule is deliberately blunt: a target must start with a single `/` and not
 * a second one. `//evil.example` is a protocol-relative URL that browsers treat
 * as absolute, and it is the case every hand-rolled check misses.
 */
export function safeRedirect(target: string | null | undefined, fallback = "/"): string {
  if (!target) return fallback;
  if (!target.startsWith("/")) return fallback;
  if (target.startsWith("//")) return fallback;
  // `/\evil.example` — some browsers normalise the backslash to a slash.
  if (target.startsWith("/\\")) return fallback;

  return target;
}
