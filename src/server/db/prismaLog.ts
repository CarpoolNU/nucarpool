/**
 * What Prisma is allowed to write to the process output.
 *
 * `client.ts` used to pass `log: ["info", "warn", "error"]` — plain level
 * strings, which is Prisma's *stdout* mode: the client formats its own error
 * and prints it, with nothing in the application able to intervene.
 * `src/pages/api/trpc/[trpc].ts` redacts the tRPC error payload in production
 * for a stated reason, and this route ran alongside it under no policy at all
 * (SCRUM-399).
 *
 * **What that route actually discloses, measured rather than assumed.** The
 * ticket was filed suspecting query parameters — "addresses and emails" — on
 * the basis that a Prisma error message quotes the values that caused it.
 * Probed against the installed Prisma 4.16.2, in both stdout and event mode,
 * with a `where: { id: "SENTINEL_VALUE" }` that never appeared in any output:
 *
 *  - **Argument values are not logged.** Not in stdout mode, not in the event
 *    payload. The suspicion in the ticket was wrong, and the severity is lower
 *    than it was filed at.
 *  - `log: []` produces no output at all, so the config is genuinely the route
 *    rather than something Prisma does unconditionally.
 *  - What *is* written is the rendered invocation (`Invalid
 *    \`prisma.user.findUnique()\` invocation`), and — where Prisma can resolve
 *    the original source — an **absolute filesystem path** and a **source
 *    excerpt of the application's own code**, followed by the actual reason.
 *  - A deployed build gets the frameless spelling, because Prisma cannot read
 *    original sources out of bundled `next build` output. So production was
 *    leaking the model and method, not the path or the source. Local
 *    development is where the path and excerpt actually appear, and there they
 *    are wanted.
 *
 * So the reason to fix this is not a data leak. It is that two routes out of
 * one request had two different policies, that a multi-line preamble per
 * failure is noise in CloudWatch, and that the control in `[trpc].ts` read as
 * complete while this one had no policy at all. The reason — the part with
 * operational value — is kept in every environment.
 */

/** One Prisma log event, structurally. Matches `Prisma.LogEvent`. */
export type PrismaLogEvent = {
  timestamp: Date;
  message: string;
  target: string;
};

/**
 * Lines belonging to the invocation preamble and code frame, which carry an
 * absolute path and the application's source rather than the failure.
 *
 * Frame lines are numbered (`  17   const x = 1;`) or arrowed (`→ 19  ...`).
 * A path line is recognised by the `:line:column` suffix Prisma appends. The
 * numbered-line pattern requires the digits to be followed by whitespace, so
 * a reason that merely begins with a number is not mistaken for a frame.
 *
 * **The invocation line has two spellings**, and the second is the one
 * production hits. Prisma writes `invocation in` followed by a path and a
 * source excerpt when it can resolve the original source, and
 * `invocation:` with no frame at all when it cannot — which is the case in a
 * bundled `next build` output. Matching only the first spelling was the bug
 * this comment exists to prevent a repeat of; it was caught by running the
 * real client rather than by the unit test's captured payload.
 */
const PREAMBLE = [
  /^Invalid `[^`]*` invocation(?: in)?:?\s*$/,
  /^.*:\d+:\d+$/,
  /^\s*\d+\s/,
  /^\s*→\s*\d+\s/,
];

/**
 * The failure reason, with the preamble and code frame removed.
 *
 * Returns the message unchanged when nothing matches, which is the case for
 * every engine-originated event — `"Starting a mysql pool with 21
 * connections."`, targeted `quaint::pooled` — since those have no preamble.
 *
 * @param message the raw `message` from a Prisma log event
 */
export function stripSourceContext(message: string): string {
  const kept = message
    .split("\n")
    .filter((line) => !PREAMBLE.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();

  // A message that is *only* preamble would otherwise be logged as an empty
  // string, which reads as "nothing went wrong". The raw message is the
  // better failure mode: it is noisy, not secret.
  return kept === "" ? message.trim() : kept;
}

/**
 * What gets logged for one Prisma event.
 *
 * `target` is kept in every environment and is the most useful field here: it
 * is `user.findUnique` for a request error and `quaint::pooled` for an engine
 * one. Note this is a **deliberate departure** from the ticket, which asked
 * that production carry no "rendered invocation" — `target` names the same
 * model and method that the stripped `Invalid \`prisma.user.findUnique()\``
 * line did. It is kept because it is the single field that makes a log line
 * actionable and it contains no argument, no path and no source.
 *
 * Outside production the raw message is passed through, so local debugging
 * keeps the code frame that points at the offending line.
 *
 * @param event the Prisma log event
 * @param nodeEnv injectable so a test never mutates `process.env`
 */
export function formatPrismaLog(
  event: PrismaLogEvent,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): { target: string; message: string } {
  return {
    target: event.target,
    message:
      nodeEnv === "production"
        ? stripSourceContext(event.message)
        : event.message,
  };
}
