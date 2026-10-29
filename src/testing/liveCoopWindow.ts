/**
 * A co-op window that contains today, for database fixtures whose subject is
 * something other than liveness.
 *
 * Since SCRUM-633 a search with no `end_date` is not live, so it is absent
 * from the candidate query and from the admin supply counters. Fixtures that
 * omitted the dates — which was every one of them, because before SCRUM-631
 * nothing read the column — therefore disappear before the rule under test is
 * reached, and the suite fails somewhere that has nothing to do with its
 * subject. Seeding these two values is how a fixture says "this row is live,
 * now test the thing I am actually about".
 *
 * **Relative to the real clock, deliberately.** These suites do not pin a
 * `now` — they let `buildCandidateWhere` default to `new Date()` — so a
 * literal window would be live until it was not, and the failure would arrive
 * as a dated test breaking for no reason anyone could connect to this. A
 * window that is always a year either side of today cannot rot, and stays
 * inside `coopYearBounds` for as long as the floor of 2022 is in the past.
 *
 * A fixture that *is* about liveness should not use these: it wants dates
 * chosen against a pinned `NOW`, which is what `coopHasNotEnded.db.test.ts`
 * does.
 *
 * Built with `Date.UTC` because `start_date` and `end_date` are `@db.Date` and
 * every writer and reader of those columns works in UTC — see the boundary
 * note in `src/server/db/coopLiveness.ts`.
 */
const today = new Date();

export const LIVE_COOP_START = new Date(
  Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1),
);

export const LIVE_COOP_END = new Date(
  Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), 1),
);
