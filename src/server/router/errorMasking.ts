import type { TRPCError } from "@trpc/server";

/**
 * What the browser is told when the server hits an unexpected fault.
 *
 * `src/pages/api/trpc/[trpc].ts` already keeps error *contents* out of
 * production logs, because "a failing Prisma query includes its parameters,
 * which here means addresses and emails". The same payload was being sent to
 * the client untouched: `initTRPC` had no `errorFormatter`, so tRPC applied its
 * default (`({ shape }) => shape`) and `shape.message` was `error.message`
 * verbatim. Several handlers render that into a toast, so a `P2025` arrived in
 * the UI as "Something went wrong: Invalid `prisma.user.update()`
 * invocation…". One half of the request was hardened and the other was open,
 * which made the protection read as complete when it was not.
 *
 * Deliberately says no more than the toast wrapping it already does. A
 * per-request reference is appended when one is available, so the user has
 * something to quote and the log line can be found — see `requestId.ts`.
 */
export const UNEXPECTED_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

/** The part of a tRPC error shape this touches. Everything else is preserved. */
type ErrorShapeLike = { message: string };

/**
 * Replaces the message on an unexpected error, and only on an unexpected one.
 *
 * **Masking is by error code, not by origin, and that distinction is the whole
 * design.** Every intentional refusal in this codebase throws `BAD_REQUEST`,
 * `FORBIDDEN`, `CONFLICT`, `NOT_FOUND` or `UNAUTHORIZED` with a message written
 * to be read by a user, and the client depends on showing those verbatim:
 * `ConnectModal` surfaces the server's refusal because every way that procedure
 * refuses is a rule the user can act on, `requestHandlers` shows membership
 * refusals as written rather than relabelled, and `NON_RETRYABLE_CODES` in
 * `src/utils/trpc.ts` exists so they are displayed instead of retried. Masking
 * by code keeps all of that intact while covering the one code that is only
 * ever a genuine fault.
 *
 * Zod input failures are unaffected for the same reason: tRPC reports them as
 * `BAD_REQUEST`.
 *
 * `INTERNAL_SERVER_ERROR` is raised deliberately in two places — `mapbox.ts`
 * and `user.ts`'s presigned-URL procedures — and masking those is harmless:
 * "Unexpected error. Please try again." and "Failed to generate a pre-signed
 * URL" tell the user no more than the replacement does. `mapbox.getDirections`
 * is the one worth noting, because it puts a third-party message
 * (`json.message`, straight from Mapbox) into a `TRPCError`; masking is an
 * improvement there rather than a loss.
 *
 * Only `message` changes. `data.code` and `data.httpStatus` are passed through
 * untouched, because the retry policy reads `error.data.code` and must behave
 * identically.
 *
 * `requestId` is what makes the masked message diagnosable. It is
 * read from the tRPC context rather than generated here, because
 * `[trpc].ts`'s `onError` has to log the *same* value: both callbacks receive
 * the context, so neither depends on the other running first. (`onError` does
 * in fact run first, but nothing here relies on that.)
 *
 * It is optional because there is one case where no id exists: if
 * `createContext` itself throws, tRPC calls both callbacks with `ctx`
 * undefined. The message then omits the reference rather than inventing one,
 * and `[trpc].ts` records that it had none.
 *
 * @param shape the error shape tRPC built, returned unchanged when not masking
 * @param code the error's tRPC code
 * @param nodeEnv injectable so a test never has to mutate `process.env`;
 *   anything other than `development` masks, so an unset value fails safe
 * @param requestId the reference to quote, when the request has one
 */
export function maskUnexpectedError<TShape extends ErrorShapeLike>(
  shape: TShape,
  code: TRPCError["code"],
  nodeEnv: string | undefined = process.env.NODE_ENV,
  requestId?: string,
): TShape {
  if (code !== "INTERNAL_SERVER_ERROR" || nodeEnv === "development") {
    return shape;
  }

  return {
    ...shape,
    message: requestId
      ? `${UNEXPECTED_ERROR_MESSAGE} Reference: ${requestId}`
      : UNEXPECTED_ERROR_MESSAGE,
  };
}
