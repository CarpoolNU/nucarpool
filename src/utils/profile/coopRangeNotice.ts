/**
 * Whether the profile page should tell this user their stored co-op range runs
 * backwards, the moment it loads.
 *
 * **Why anything is needed.** `user.edit` and `onboardSchema` now
 * reject a range whose end precedes its start, and that was not retroactive:
 * production carries **47** searches that already store one, 40 of them
 * `ACTIVE` (measured 2026-09-09). Every one of those users is
 * invisible in matching and sees an empty map, because `dateOverlapFilter` asks
 * for `startDate <= theirs AND endDate >= theirs` and an inverted range
 * satisfies that for nobody.
 *
 * **What they see today, and why it is not enough.** The dates are editable on
 * the profile page's Account tab, `AccountSection` renders
 * `errors.coopEndDate.message`, and `onError` routes a failed save to that tab
 * with a toast. So the machinery to tell them exists — but the form is
 * `mode: "onChange"`, which does not validate on mount. Nothing surfaces until
 * the user changes a field or presses Save. A user whose only symptom is an
 * empty explore map has no reason to do either, and no reason to suspect their
 * profile at all.
 *
 * So this fires on load, and only for the defect it names.
 *
 * **A second defect, the same remedy (SCRUM-550).** Production also holds
 * searches whose years are absurd — 1901→1908, 2069→2073 — and whose ordering
 * is fine, so the check above never saw them. Rewriting them would be a guess,
 * since adding a century still lands before this platform existed; only the
 * student knows what they meant. So they get the same treatment: told on load,
 * gated on the stored year actually falling outside `coopYearBounds`.
 *
 * **Deliberately not "validate the whole form on mount".** That would have been
 * one `trigger()` call, and it would show red errors on open to every user
 * carrying any other incomplete state — a change to everyone's experience in
 * order to reach 47 rows. This is gated on the stored range actually being
 * inverted, so a user without the defect sees no difference whatsoever.
 *
 * **Deliberately not a server log either.** The other candidate read path was
 * `user.me`, which already flattens both columns. Nobody
 * knows where deployed server logs are read, so a line there would be
 * unfalsifiable; and the population is already reportable through
 * `scripts/check-profile-coordinates.ts`. Telling the affected person beats
 * telling a log nobody has located.
 *
 * Pure and separate from `src/pages/profile/index.tsx` on purpose: that file is
 * 1300 lines behind Mapbox, NextAuth and a dozen tRPC queries, and a decision
 * left inline there is a decision nothing can test.
 */

import { Role } from "@prisma/client";
import {
  implausibleCoopYearFields,
  reversedCoopRangeFields,
} from "../dateUtils";

/**
 * What the page should do about it.
 *
 * `tab` and `field` are returned rather than assumed by the caller so the
 * routing is part of the tested decision: the notice is worthless if it lands
 * the user on a tab that does not show the field.
 */
export type CoopRangeNotice = {
  /** The profile tab holding the co-op date pickers. */
  tab: "account";
  /**
   * The fields `onboardSchema` attaches this defect's issues to, for the page
   * to `trigger`. Plural because an implausible year is usually on both dates
   * — 1901→1908 is the commonest production shape — and marking only one
   * would leave the user to discover the other on save.
   */
  fields: ("coopStartDate" | "coopEndDate")[];
  message: string;
};

/**
 * Names the consequence, not just the rule.
 *
 * `COOP_DATE_ORDER_MESSAGE` ("End date cannot be before the start date") is the
 * right text beside the field, and on its own it reads as a form nicety. These
 * users have been unmatchable for months without knowing, so the toast says
 * what it cost them and what fixes it.
 */
export const REVERSED_COOP_RANGE_NOTICE =
  "Your co-op end date is before your start date, so you are not appearing " +
  "in anyone's matches. Pick the right months below and save to fix it.";

/**
 * The same, for a year outside `coopYearBounds` (SCRUM-550). Production holds
 * searches dated like 1901→1908, and those users drop out of any search
 * filtered on term-date overlap. That filter defaults to "Any", so unlike the
 * reversed case they are not invisible by default — the toast says only what
 * is true.
 */
export const IMPLAUSIBLE_COOP_YEAR_NOTICE =
  "Your co-op dates are set to a year that cannot be right, so your profile " +
  "shows the wrong dates and you are left out of searches that filter by " +
  "co-op dates. Pick the right months below and save to fix it.";

/**
 * The decision.
 *
 * `alreadyShown` is the caller's, not ours: the effect that reads the user also
 * re-runs on every refetch, and yanking someone back to the Account tab each
 * time would be its own defect. Passing it in keeps this function pure and
 * leaves the latch where the render lives.
 *
 * A `null` on either side is not a reversed range — `isReversedCoopRange`
 * requires both — and neither is an equal pair, because both pickers are
 * month-granularity and a one-month co-op legitimately stores the same date
 * twice.
 */
export const planCoopRangeNotice = ({
  role,
  coopStartDate,
  coopEndDate,
  alreadyShown,
  now,
}: {
  role: Role;
  coopStartDate: Date | null | undefined;
  coopEndDate: Date | null | undefined;
  alreadyShown: boolean;
  /** Only for tests: the ceiling of `coopYearBounds` moves with the clock. */
  now?: Date;
}): CoopRangeNotice | null => {
  if (alreadyShown) {
    return null;
  }

  // One notice, never two. The year is checked first because it is the more
  // complete description: a range reading 1913→1907 is also reversed, but
  // swapping the two would not fix it. `onboardSchema` orders its issues the
  // same way, so the field shows the message the toast explains. A VIEWER
  // gets neither notice, for the reason `implausibleCoopYearFields` gives:
  // both would send them to pickers they cannot change.
  const implausible = implausibleCoopYearFields({
    role,
    coopStartDate,
    coopEndDate,
    now,
  });

  if (implausible.length > 0) {
    return {
      tab: "account",
      fields: implausible,
      message: IMPLAUSIBLE_COOP_YEAR_NOTICE,
    };
  }

  const reversed = reversedCoopRangeFields({
    role,
    coopStartDate,
    coopEndDate,
  });

  if (reversed.length === 0) {
    return null;
  }

  return {
    tab: "account",
    fields: reversed,
    message: REVERSED_COOP_RANGE_NOTICE,
  };
};
