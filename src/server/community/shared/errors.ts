/**
 * The domain error hierarchy.
 *
 * **`TRPCError` never appears below the transport layer.** That is not a
 * stylistic preference: it is what lets a service be constructed and exercised
 * in a test with no tRPC, no HTTP and no session. The transport layer maps
 * these to codes in exactly one place — `toTRPCError` in
 * `src/server/router/community/errorMapping.ts`.
 */

export type DomainErrorCode =
  | "HANDLE_INVALID"
  | "HANDLE_TAKEN"
  | "PROFILE_EXISTS"
  | "NOT_ELIGIBLE"
  | "NOT_AUTHOR"
  | "CONTENT_UNAVAILABLE"
  | "CATEGORY_UNKNOWN"
  | "TEXT_TOO_LONG"
  | "TEXT_EMPTY"
  | "RATE_LIMITED"
  | "NOT_MODERATOR"
  | "ALREADY_RESOLVED";

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  constructor(message: string) {
    super(message);
    // Without this, `instanceof` fails for subclasses of Error under the
    // ES5 downlevel emit some toolchains still use.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HandleInvalidError extends DomainError {
  readonly code = "HANDLE_INVALID" as const;
}

export class HandleTakenError extends DomainError {
  readonly code = "HANDLE_TAKEN" as const;
  constructor() {
    super("That handle is already taken.");
  }
}

export class ProfileExistsError extends DomainError {
  readonly code = "PROFILE_EXISTS" as const;
  constructor() {
    super("You already have a community handle.");
  }
}

export class NotEligibleError extends DomainError {
  readonly code = "NOT_ELIGIBLE" as const;
}

export class NotAuthorError extends DomainError {
  readonly code = "NOT_AUTHOR" as const;
  constructor() {
    super("You can only change your own posts.");
  }
}

/**
 * Content that is deleted, hidden, or authored by a block counterpart.
 *
 * **The message is content-shaped on purpose, and the three cases are
 * deliberately indistinguishable.** NUCarpool's `BLOCKED_PAIR_MESSAGE` — "This
 * user isn't available" — is correct on the carpool side, where the
 * counterpart is already named on screen. Reusing it here would be an identity
 * leak: a user could probe each handle in turn and learn, from which ones
 * refused, exactly which handles belong to people they have a block with,
 * turning a block list into a partial handle-to-person map.
 *
 * Transport maps this to NOT_FOUND, not FORBIDDEN, for the same reason.
 */
export class ContentUnavailableError extends DomainError {
  readonly code = "CONTENT_UNAVAILABLE" as const;
  constructor() {
    super("This content isn't available.");
  }
}

export class CategoryUnknownError extends DomainError {
  readonly code = "CATEGORY_UNKNOWN" as const;
  constructor(slug: string) {
    super(`No such category: ${slug}`);
  }
}

export class TextTooLongError extends DomainError {
  readonly code = "TEXT_TOO_LONG" as const;
}

export class TextEmptyError extends DomainError {
  readonly code = "TEXT_EMPTY" as const;
}

/**
 * A per-user, per-action budget spent for this window.
 *
 * **The message names no limit and no reset time, deliberately.** A limit
 * disclosed is a limit designed around: telling a caller it may post ten times
 * an hour, or that the window turns over in eleven minutes, hands an abusive
 * client the two numbers it needs to pace itself to just under the cap forever.
 * A vague refusal costs a legitimate user nothing they can act on differently —
 * they wait and try again either way. See the rate-limiting spec, §9.2.
 *
 * Transport maps this to TOO_MANY_REQUESTS.
 */
export class RateLimitedError extends DomainError {
  readonly code = "RATE_LIMITED" as const;
  constructor() {
    super("You're doing that too often. Try again later.");
  }
}

/**
 * A moderation action attempted by someone who is not a moderator.
 *
 * **The message names the rule, not a remedy.** `NotEligibleError` tells a
 * student to choose a handle because that is something they can do. There is
 * nothing a member can do to become a moderator, so there is nothing to
 * suggest.
 *
 * Transport maps this to FORBIDDEN, following `NotAuthorError` rather than
 * `ContentUnavailableError`. NOT_FOUND exists to hide that a surface is there;
 * it buys nothing here, because the router's shape ships in the client's type
 * graph and the moderation procedures are visible to anyone who reads it.
 */
export class NotModeratorError extends DomainError {
  readonly code = "NOT_MODERATOR" as const;
  constructor() {
    super("Only moderators can do that.");
  }
}

/**
 * A report that someone else has already reviewed.
 *
 * **This is reachable only through the conditional update, never through the
 * prior read.** A service reads the report first and may notice it is resolved,
 * but that read is a convenience for a friendlier early exit: two moderators can
 * both read it as open and both proceed. The conditional update, which only
 * writes while the report is still open, is the arbiter. Whichever update
 * matches no row is the one that lost, and that loss is what raises this error.
 *
 * Transport maps this to CONFLICT: the request was well formed and permitted,
 * and it failed because the state it assumed is gone.
 */
export class AlreadyResolvedError extends DomainError {
  readonly code = "ALREADY_RESOLVED" as const;
  constructor() {
    super("This report has already been reviewed.");
  }
}
