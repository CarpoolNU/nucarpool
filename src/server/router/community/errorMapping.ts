import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import {
  DomainError,
  type DomainErrorCode,
} from "../../community/shared/errors";

/**
 * The single place domain errors become transport errors.
 *
 * Keeping this at the boundary is what lets every service run in a test with
 * no tRPC and no HTTP. Adding a `DomainErrorCode` without adding it here is a
 * compile error, because the map is exhaustive by type.
 */
export const DOMAIN_ERROR_CODES: Record<DomainErrorCode, TRPC_ERROR_CODE_KEY> =
  {
    HANDLE_INVALID: "BAD_REQUEST",
    HANDLE_TAKEN: "CONFLICT",
    PROFILE_EXISTS: "CONFLICT",
    // FORBIDDEN rather than UNAUTHORIZED: they are signed in, they just have no
    // handle yet. UNAUTHORIZED would prompt the client to re-authenticate.
    NOT_ELIGIBLE: "FORBIDDEN",
    NOT_AUTHOR: "FORBIDDEN",
    /**
     * NOT_FOUND, not FORBIDDEN, and that choice is load-bearing.
     *
     * Deleted, moderator-hidden and blocked-author content must be
     * indistinguishable. FORBIDDEN would confirm that something is there,
     * letting a user probe handles and learn which ones belong to people they
     * have a block with — a partial handle-to-person map built out of error
     * codes. See the spec, §7.2.
     */
    CONTENT_UNAVAILABLE: "NOT_FOUND",
    CATEGORY_UNKNOWN: "NOT_FOUND",
    TEXT_TOO_LONG: "BAD_REQUEST",
    TEXT_EMPTY: "BAD_REQUEST",
    /**
     * The budget for this action and window is spent.
     *
     * TOO_MANY_REQUESTS is the only code that tells a client to back off rather
     * than to change its request, which is what a rate limit means. The message
     * carried alongside it names no limit and no reset time — see
     * `RateLimitedError` for why.
     */
    RATE_LIMITED: "TOO_MANY_REQUESTS",
    /**
     * FORBIDDEN, unlike the CONTENT_UNAVAILABLE precedent above, and that choice
     * is deliberate.
     *
     * NOT_FOUND is what hides that a surface exists. It buys nothing here: the
     * router's shape ships in the client's type graph, so the moderation
     * procedures are visible to anyone who reads it, and a NOT_FOUND would only
     * be a lie. NOT_AUTHOR is the honest precedent to follow.
     */
    NOT_MODERATOR: "FORBIDDEN",
    // CONFLICT, as for HANDLE_TAKEN: the request was valid and permitted, and
    // lost a race against another moderator's review of the same report.
    ALREADY_RESOLVED: "CONFLICT",
  };

/**
 * Maps a domain error to a `TRPCError`, and rethrows anything else untouched.
 *
 * Unexpected faults must stay unexpected: `createRouter.ts` masks the message
 * of an INTERNAL_SERVER_ERROR before it reaches the browser, and wrapping a
 * Prisma fault in a tidy code here would route around that masking.
 */
export const toTRPCError = (error: unknown): never => {
  if (error instanceof DomainError) {
    throw new TRPCError({
      code: DOMAIN_ERROR_CODES[error.code],
      message: error.message,
      cause: error,
    });
  }
  throw error;
};
