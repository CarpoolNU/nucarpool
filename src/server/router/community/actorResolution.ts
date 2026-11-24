import type { CommunityActor, ProfileRef } from "../../community/actor";

/**
 * Turns a NextAuth session plus a profile row into a `CommunityActor`.
 *
 * **This is the only place in the system where that conversion happens.**
 * Everything below the transport layer receives the actor as an argument and
 * never reads `ctx.session`, imports `next-auth`, or knows a session exists.
 * That is what keeps authentication, community identity and authorization
 * three separate concerns rather than one tangled check repeated per procedure.
 *
 * Pure, so it is tested with object literals rather than a signed cookie.
 */

export type SessionUser = {
  id: string;
  permission: "USER" | "ADMIN" | "MANAGER";
};

export const resolveActor = (
  user: SessionUser,
  profile: ProfileRef | null,
): CommunityActor => {
  if (!profile) {
    // No handle yet. They may read; they may not write. The handle-claim gate
    // is the only thing this actor can usefully do.
    return { kind: "student", userId: user.id };
  }

  // Moderator is the platform's existing `adminRouter` predicate, deliberately.
  // Community does not define a moderator role of its own — see the spec's
  // unresolved assumptions.
  return user.permission === "USER"
    ? { kind: "member", userId: user.id, profile }
    : { kind: "moderator", userId: user.id, profile };
};
