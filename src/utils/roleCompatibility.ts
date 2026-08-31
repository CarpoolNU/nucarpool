import { Role } from "@prisma/client";

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
