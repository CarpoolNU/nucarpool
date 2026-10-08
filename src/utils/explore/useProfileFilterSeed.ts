import { Dispatch, SetStateAction, useEffect } from "react";
import { FiltersState, User } from "../types";

/**
 * Seeds the explore filters' dates and days from the signed-in user's profile.
 *
 * **Keyed on the profile's four scalar values, not on the `user` object.**
 * Accepting a request, leaving a group and saving group preferences all
 * invalidate `user.me`, and every refetch hands back a new object - so
 * depending on `[user]` instead would silently write the profile's days and
 * dates back over whatever the user had set in the filter panel on every one
 * of those refetches, and, because `filters` would then change, refetch
 * recommendations too.
 *
 * The dates are compared by timestamp because superjson rebuilds a `Date` on
 * every fetch: the same stored day arrives as a different object each time.
 * A genuine change to any of these four values still re-seeds, which is what
 * keeps the filters in step with a profile that really did change.
 *
 * A VIEWER is not seeded. They have no schedule of their own to match
 * against, so the defaults stand.
 */
export const useProfileFilterSeed = (
  user:
    | Pick<User, "role" | "coopStartDate" | "coopEndDate" | "daysWorking">
    | null
    | undefined,
  setFilters: Dispatch<SetStateAction<FiltersState>>,
): void => {
  const role = user?.role;
  const startTime = user?.coopStartDate?.getTime();
  const endTime = user?.coopEndDate?.getTime();
  const daysWorking = user?.daysWorking;

  useEffect(() => {
    if (role === undefined || role === "VIEWER" || daysWorking === undefined) {
      return;
    }
    setFilters((prev) => ({
      ...prev,
      startDate: startTime !== undefined ? new Date(startTime) : prev.startDate,
      endDate: endTime !== undefined ? new Date(endTime) : prev.endDate,
      daysWorking,
    }));
  }, [role, startTime, endTime, daysWorking, setFilters]);
};
