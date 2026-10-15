import { Permission, Role } from "@prisma/client";
import { AdminUser } from "../../utils/types";

/**
 * Whether the user-management screen may offer "Set to Viewer" for the
 * selected row, and what to tell the manager when it may not.
 *
 * A discriminated union rather than a bare boolean plus a string: there is no
 * reason to hold when the action is available, and this makes that
 * unrepresentable instead of conventional.
 */
export type ViewerActionState =
  { enabled: true } | { enabled: false; reason: string };

/**
 * The eligibility rules, in the order a manager should hear them.
 *
 * **Every one of these is also enforced in `user.admin.setUserToViewer`, and
 * the server is the real boundary** — this copy exists so an ineligible row is
 * explained before the click rather than as an error toast after it. A stale
 * or hand-rolled client reaches the same refusals. If the two ever disagree,
 * the server is right and this is the one to fix.
 *
 * The caller's own permission is checked first, deliberately: for an admin it
 * is true of every row, so leading with a per-row reason would invite them to
 * pick someone else and get the same refusal.
 */
export const viewerActionState = (
  user: AdminUser | null,
  callerPermission: Permission,
): ViewerActionState => {
  if (callerPermission !== Permission.MANAGER) {
    return {
      enabled: false,
      reason: "Only a manager can change a user's carpool role.",
    };
  }

  if (!user) {
    return { enabled: false, reason: "Select a user first." };
  }

  // One search per user, so the first is the only one. An empty array is
  // someone who never onboarded; they already read as a VIEWER everywhere
  // else, so there is nothing this action would change.
  const search = user.carpoolSearches[0];

  if (!search) {
    return {
      enabled: false,
      reason: "This user has no carpool search to change.",
    };
  }

  // Refused for a group invariant rather than for tidiness: a group whose only
  // driver became a VIEWER is one that `requireGroupDriver` locks everybody
  // out of, so it can no longer be dissolved or departed. `user.edit` refuses
  // the same change to the user themselves.
  if (search.carpoolId) {
    return {
      enabled: false,
      reason:
        "This user is in a carpool group. They must leave or dissolve it " +
        "first.",
    };
  }

  if (search.role === Role.VIEWER) {
    return { enabled: false, reason: "This user is already a viewer." };
  }

  return { enabled: true };
};
