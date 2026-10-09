/**
 * Whether `InactiveBlocker` is on screen.
 *
 * One function rather than the condition written at each site, because three
 * behaviours now depend on the same answer and they have to agree:
 *
 * 1. the blocker itself renders, inside `#map`;
 * 2. the desktop header's tabs go disabled;
 * 3. the mobile explore sheet opens `collapsed` instead of `expanded`, so it
 *    does not paint over the blocker - `defaultSheetDetent` in
 *    `../explore/sheetDetents.ts`.
 *
 * The third is new, and it is what turned a repeated inline condition into a
 * liability rather than merely a duplication. The sheet and the blocker are in
 * different stacking contexts, so if the sheet's copy of the condition ever
 * disagreed with the blocker's, the sheet would open over a blocker the user
 * cannot then reach - which is the defect this predicate was extracted to make
 * unrepresentable, not just unlikely.
 *
 * **Pure, and deliberately not in the component.** `InactiveBlocker.tsx`
 * imports React and `next/router`; `sheetDetents.ts` is a pure module whose
 * test suite would have to load both to read a boolean off it. The rule lives
 * here so neither side pays for the other.
 *
 * **A VIEWER is exempt at either status.** The role browses and cannot
 * connect, so there is nothing for it to be inactive *from* and the blocker
 * has never applied to it. That is not a theoretical combination - production
 * holds 38 INACTIVE VIEWER rows against 1,095 INACTIVE RIDER and 93 INACTIVE
 * DRIVER.
 *
 * @param role the user's role, `undefined` while `user.me` is in flight
 * @param status the user's activity status, `undefined` likewise. Both are
 *   optional because the sheet's opening detent is computed from `user?.role`
 *   and `user?.status` before the query resolves. An unknown role returns
 *   false rather than treating "not a VIEWER" as satisfied by `undefined`:
 *   not blocking an account that may well be active is the safer of the two
 *   errors, and it is what the page did before this predicate existed.
 */

import { Role, Status } from "@prisma/client";

export const showsInactiveBlocker = ({
  role,
  status,
}: {
  role?: Role;
  status?: Status;
}): boolean =>
  role !== undefined && role !== Role.VIEWER && status === Status.INACTIVE;
