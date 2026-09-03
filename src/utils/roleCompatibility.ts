import { Role, Status } from "@prisma/client";

/**
 * Whether two roles can carpool together.
 *
 * A carpool is one driver and one rider, so exactly one of the pair has to be
 * each. VIEWER is neither: it is the browsing role, which is why discovery
 * excludes it on both sides (`recommendation.ts`, `candidateSearch.ts`).
 *
 * This is deliberately *not* what decides whether an existing request is
 * visible. Requests survive a role change on either side, because a request is
 * a relationship the two people already established and the app's own
 * duplicate guard keeps treating it as one; role compatibility governs
 * discovery, and whether the request can be *accepted*.
 */
export const canCarpoolTogether = (a: Role, b: Role): boolean =>
  (a === Role.DRIVER && b === Role.RIDER) ||
  (a === Role.RIDER && b === Role.DRIVER);

/**
 * Why this pair cannot carpool, phrased for the person reading it, or `null`
 * when they can.
 *
 * Roles change legitimately at co-op-cycle boundaries, so a request whose two
 * parties no longer fit is an ordinary state rather than an error - the point
 * of the copy is to name which side moved and what would resolve it, so that
 * the request reads as explained rather than broken.
 *
 * `otherName` is the counterpart's `preferredName`. The caller's own role is
 * checked first: when both are VIEWERs, the one the reader can act on is
 * their own.
 */
export const roleMismatchExplanation = (
  userRole: Role,
  otherRole: Role,
  otherName: string,
): string | null => {
  if (canCarpoolTogether(userRole, otherRole)) {
    return null;
  }

  if (userRole === Role.VIEWER) {
    return (
      `You are in Viewer mode, so you cannot carpool with ${otherName}. ` +
      "Switch to Driver or Rider in your profile."
    );
  }

  if (otherRole === Role.VIEWER) {
    return (
      `${otherName} has switched to Viewer mode and is not carpooling right ` +
      "now. You can keep messaging them, or clear the request."
    );
  }

  if (userRole === Role.DRIVER) {
    return (
      `You and ${otherName} are both drivers, so you cannot carpool ` +
      "together. One of you would need to switch to Rider."
    );
  }

  return (
    `You and ${otherName} are both riders, so neither of you can drive. ` +
    "One of you would need to switch to Driver."
  );
};

/**
 * Why a favourite cannot be carpooled with *right now*, or `null` when they
 * can.
 *
 * `favorites.me` used to drop any favourite whose role matched the caller's,
 * was VIEWER, or whose search was INACTIVE. That left no card, so no star, so
 * no way to un-favourite them — the `_Favorites` row became permanent and
 * invisible. Favourites are a list the user curated, so they survive the other
 * person changing role or pausing, exactly as requests do; this is the copy
 * that makes the entry read as explained rather than broken.
 *
 * Deliberately *not* `roleMismatchExplanation` alone, for two reasons:
 *
 *   - Status is not a role. Someone who has paused their search is not looking
 *     for a carpool at all, which makes their role beside the point — so it is
 *     answered first.
 *   - That function's other-VIEWER branch ends "You can keep messaging them,
 *     or clear the request", which is request copy. There is no request on a
 *     favourite, so this says the same thing without the instruction.
 *
 * The remaining cases — the reader in Viewer mode, and two riders or two
 * drivers — read correctly for a favourite as they stand, so they are shared
 * rather than reworded.
 */
export const carpoolUnavailableExplanation = (
  userRole: Role,
  other: { role: Role; status: Status; preferredName: string },
): string | null => {
  const name = other.preferredName;

  if (other.status === Status.INACTIVE) {
    return `${name} has paused their carpool search, so you cannot carpool with them right now.`;
  }

  // Their own Viewer mode, but only when it is not also the reader's: when both
  // are VIEWERs the one the reader can act on is their own, which is the branch
  // below.
  if (userRole !== Role.VIEWER && other.role === Role.VIEWER) {
    return `${name} has switched to Viewer mode and is not carpooling right now.`;
  }

  return roleMismatchExplanation(userRole, other.role, name);
};
