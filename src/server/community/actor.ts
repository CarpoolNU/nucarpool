import { NotEligibleError, NotModeratorError } from "./shared/errors";

/**
 * Who is acting, as Community understands it.
 *
 * **This is where authentication, community identity and authorization stop
 * being the same question.** NextAuth answers "which NUCarpool user is this";
 * `CommunityProfile` answers "who are they here"; the policies below answer
 * "what may they do". Keeping them apart is what makes the pseudonymity
 * guarantee auditable rather than aspirational.
 *
 * **Transport is the only layer that builds one of these.** Nothing below it
 * reads `ctx.session`, imports `next-auth`, or knows a session exists.
 *
 * **The union is also the extension point for account restriction.** NUCarpool
 * has no suspension or ban concept today, so none is invented here. When the
 * platform adds one it enters as a fourth `kind`, and every write path typed
 * against `Member` stops compiling until it is handled — which is the point of
 * a discriminated union rather than a bag of booleans.
 */

/** The handle, and nothing platform-derived. */
export type ProfileRef = {
  id: string;
  handle: string;
};

export type CommunityActor =
  | { kind: "student"; userId: string }
  | { kind: "member"; userId: string; profile: ProfileRef }
  | { kind: "moderator"; userId: string; profile: ProfileRef };

/**
 * An actor who may write. `canCreatePost(actor: Member)` cannot be called with
 * a `student` — it does not compile, which is the whole point of the tier
 * being a type rather than an `if` repeated across every write procedure.
 */
export type Member = Extract<CommunityActor, { kind: "member" | "moderator" }>;

export const isMember = (actor: CommunityActor): actor is Member =>
  actor.kind === "member" || actor.kind === "moderator";

export type Moderator = Extract<CommunityActor, { kind: "moderator" }>;

export const isModerator = (actor: CommunityActor): actor is Moderator =>
  actor.kind === "moderator";

/**
 * Narrows to `Member` or refuses.
 *
 * The refusal names the remedy rather than the rule, because the only way to
 * reach it is to not yet have claimed a handle.
 */
export const requireMember = (actor: CommunityActor): Member => {
  if (!isMember(actor)) {
    throw new NotEligibleError("Choose a community handle before posting.");
  }
  return actor;
};

/**
 * Narrows to `Moderator` or refuses.
 *
 * **This is a runtime check, not a compile-time one.** No moderation function
 * takes a `Moderator` parameter: `ModerationService.queue` and `.review` take
 * `CommunityActor` and narrow it themselves, so a handler that skips this call
 * still compiles. The tier is enforced twice, at the procedure and again in the
 * service, which is deliberate defence in depth across the layer boundary —
 * removing either check on the belief that the compiler backs the other would
 * leave one layer holding the whole rule. The refusal names the rule rather
 * than a remedy, because there is nothing a member can do to become a
 * moderator. Moderator status follows the platform's own predicate, which
 * `resolveActor` applies: ADMIN and MANAGER alike.
 */
export const requireModerator = (actor: CommunityActor): Moderator => {
  if (!isModerator(actor)) {
    throw new NotModeratorError();
  }
  return actor;
};

/** Authors may change their own content; moderators may act on any. */
export const canModifyContent = (actor: Member, authorId: string): boolean =>
  actor.userId === authorId || isModerator(actor);
