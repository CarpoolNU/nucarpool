import { Prisma } from "@prisma/client";
import { coopYearBounds } from "../../utils/dateUtils";

/**
 * "This co-op is live" — the rule the match pool and the admin supply counters
 * both read, and the two halves it is made of.
 *
 * `CarpoolSearch.status` is set by the user and never by the calendar.
 * SCRUM-30 specified date-driven deactivation in 2024 and the effect never
 * reached production, so an `ACTIVE` row means "nobody has switched this off",
 * not "this co-op is running". Until something writes `status` on a schedule —
 * a sibling ticket, gated on AWS access this repository has no credential for
 * — liveness has to be **derived at read time**, which is what this module is.
 *
 * Before this existed, the candidate query's only date predicate was
 * `dateOverlapFilter`, which compares a candidate against *the searcher's own*
 * co-op window and returns nothing at all when `filters.dateOverlap === 0` —
 * the default every user starts on. Liveness was therefore an accident of the
 * searcher's filter settings rather than a property of the data, and the
 * default state was the unprotected one. See SCRUM-631.
 *
 * ---
 *
 * **Liveness is two rules, kept separate on purpose.**
 *
 * `coopHasNotEnded*` is the floor: `end_date` is today or later.
 * `coopEndsBeforeYearCeiling*` is the ceiling: `end_date` falls inside
 * `coopYearBounds`. `coopIsLive*` is the two `AND`ed together, and it is what
 * the callers use.
 *
 * SCRUM-631 shipped the floor alone, and a one-sided rule admits the
 * mirror-image bad row: a search whose `end_date` is implausibly far in the
 * future passes as live precisely *because* its date is wrong. Production on
 * 2026-10-27 held two such rows — RIDER, ACTIVE, co-ops dated 2069→2073 and
 * 2069→2074 — the two-digit-century-pivot shape `coopYearBounds` already
 * documents. `isImplausibleCoopYear` knew those dates were wrong; the match
 * pool did not consult it. SCRUM-699 is that consultation.
 *
 * They are two exported predicates rather than one widened one because they
 * answer different questions, and a reader of `coopHasNotEnded*` should not
 * have to discover that it also holds an opinion about absurd years. The
 * ceiling needs only an upper bound: a year below `coopYearBounds`' floor is
 * in the past, so the floor rule already removes it and a second term for it
 * would be a clause that can never change an answer.
 *
 * ---
 *
 * **The boundary is a UTC calendar day, inclusive.**
 *
 * `start_date` and `end_date` are `@db.Date`, written by `lastDayOfMonthUTC`
 * in `utils/dateUtils.ts`, which builds the day with `Date.UTC` precisely so
 * the stored day is the same wherever the user sat when they picked it. Every
 * other reader of these columns takes the UTC day back out — `coopYearBounds`
 * and `formatDateToMonth` both use `getUTC*` and say why. Comparing in any
 * other frame reads the column in a frame it was not written in, and the error
 * is a whole day at the boundary.
 *
 * Inclusive (`>=`) because `end_date` holds the **last day** of the co-op, not
 * the day after it. A co-op whose `end_date` is today is running today, and
 * `>` would drop every co-op on its final day. `coopHasNotEnded.db.test.ts`
 * covers that boundary against real MySQL and fails if the comparison is
 * flipped either way.
 *
 * The **ceiling is exclusive** for the mirror of the same reason, and
 * `coopYearCeilingBoundary` explains it where it is defined: it is the first
 * instant that is too late rather than the last one that is allowed.
 *
 * ---
 *
 * **A null `end_date` is excluded. Deliberately.** By both halves, so
 * composing them does not quietly reverse the decision.
 *
 * A null cannot be compared, so the predicate must either admit the dateless
 * rows or exclude them. SCRUM-631 admitted them and left the real choice to be
 * made on measurement; **SCRUM-633 is that measurement, and it reversed the
 * decision.** Measured read-only against PlanetScale `main` on **2026-10-29**.
 *
 * Both callers of this rule already restrict to DRIVER and RIDER — the
 * candidate query through `compatibleRoles`, the admin supply chart through an
 * explicit `role IN (...)` — so a VIEWER is out of reach of this predicate and
 * the only rows it can decide are DRIVER/RIDER ones. There are **142** of
 * those with no dates stored, 44 of them onboarded. Crossed against
 * `session.expires`, which NextAuth writes 30 days ahead of a sign-in and is
 * the only engagement signal the schema carries that is not a migration
 * artifact:
 *
 *   - **0** have signed in within 120 days — in either the onboarded or the
 *     un-onboarded half, and the figure is zero rather than small
 *   - the most recent session expiry in the whole cohort is **2026-02-27**,
 *     so the most recent sign-in is about **nine months** ago
 *   - **6** have no `session` row at all, having never signed in
 *   - all 142 were created by the **2025-12-17** bulk load and 43 of the 44
 *     onboarded rows have had no write since
 *
 * So the cohort this rule governs is pre-enforcement residue, not live users:
 * `onboardSchema` has required both co-op dates of every non-VIEWER since
 * before any of these rows could be written today, which is why none has been
 * created since the load.
 *
 * The large dateless population is real but is a **different** population.
 * 1,427 dateless rows are VIEWERs and 110 of those signed in within 30 days —
 * genuinely live people. For a VIEWER a null date is *correct*: the schema
 * exempts them, their pickers are disabled, and `compatibleRoles` keeps them
 * out of every candidate set. Nothing about them is missing and this rule
 * cannot touch them. The 1,489 that SCRUM-549 and SCRUM-631 both quoted was
 * the raw `ACTIVE` count, which conflates the two.
 *
 * The cost of excluding nulls is therefore 142 rows nobody has used in nine
 * months, and the benefit is that a dateless row is no longer visible or
 * invisible according to a filter the searcher never touched — see
 * `dateOverlapFilter`, whose `notNull` guard dropped these rows the moment any
 * date preference was expressed and kept them otherwise. The user-visible
 * failure mode is also self-healing and not silent: should one of the 44
 * return, the profile form refuses to save a non-VIEWER with an empty co-op
 * date ("Cannot be empty"), so they must supply the dates that put them back
 * in the pool.
 *
 * ---
 *
 * **This is the one predicate in the candidate query that is not a superset of
 * what `calculateScore` would keep**, and the exception is deliberate.
 * `candidateSearch.ts`'s header states the superset rule because every mirrored
 * filter there exists to save a read without changing an answer. This one
 * exists to *change the answer*: the scorer has no concept of liveness and
 * would happily rank a co-op that ended in 2024, or one dated 2073. Narrowing
 * in SQL is the fix, not a side effect of it.
 *
 * ---
 *
 * **Two renderings, one set of boundaries.** The candidate query takes a
 * Prisma `where` and the admin supply counter is raw SQL — Prisma's `groupBy`
 * cannot group by a related table's column, which is why that query is raw in
 * the first place. Neither language can be expressed in the other, so what is
 * shared is the boundaries themselves: every rendering below calls
 * `coopLivenessBoundary` or `coopYearCeilingBoundary` and nothing else decides
 * a day. `coopHasNotEnded.db.test.ts` asserts the two select the same row ids
 * from the same table, which is the control that keeps them from drifting —
 * adjacency is not one.
 */

/**
 * Midnight UTC on the UTC calendar day containing `now`.
 *
 * Built from `getUTC*` only, so it is the same instant whatever `TZ` the
 * process runs under. That matters beyond tidiness: CI runs Jest twice, once
 * under UTC and once under `America/New_York`, and a boundary derived from
 * local getters would differ between the two arms for the five hours each day
 * when the two dates disagree.
 */
export const coopLivenessBoundary = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * The same day as `YYYY-MM-DD`, for the raw-SQL rendering.
 *
 * A bare date string rather than a `Date`, so MySQL compares a DATE column
 * against a DATE literal and no driver gets the chance to coerce a timestamp
 * through a session time zone on the way. `toISOString` is safe here because
 * the argument is always midnight UTC by construction.
 */
export const coopLivenessDay = (now: Date = new Date()): string =>
  coopLivenessBoundary(now).toISOString().slice(0, 10);

/**
 * Midnight UTC on 1 January of the year *after* `coopYearBounds`' ceiling —
 * the exclusive upper bound an `end_date` has to fall below.
 *
 * **Derived from `coopYearBounds`, never re-typed.** That function is the one
 * place deciding which years a co-op may fall in, the profile form and
 * `user.edit` already refuse anything outside it, and a literal here would be
 * a second opinion that goes stale the year the ceiling moves — which it does
 * every year, the ceiling being relative (`currentYear + 10`).
 *
 * Exclusive, and expressed as the following 1 January rather than as 31
 * December of `latest`, because `coopYearBounds` is a rule about **years**:
 * "the end year is at most `latest`" is exactly "the date falls before
 * `latest + 1` began", and stating it that way needs no view about which day
 * a year ends on.
 */
export const coopYearCeilingBoundary = (now: Date = new Date()): Date =>
  new Date(Date.UTC(coopYearBounds(now).latest + 1, 0, 1));

/**
 * The same day as `YYYY-MM-DD`, for the raw-SQL rendering, and a bare date
 * string for the reason `coopLivenessDay` gives.
 */
export const coopYearCeilingDay = (now: Date = new Date()): string =>
  coopYearCeilingBoundary(now).toISOString().slice(0, 10);

/**
 * The Prisma rendering of the floor: searches whose co-op has not ended.
 *
 * A plain comparison, which excludes a dateless row on its own: `NULL >= x` is
 * NULL rather than true, and a `WHERE` keeps only what is true. That is
 * SCRUM-633's decision and not a side effect of the operator — the section
 * above is where it is argued, and `coopHasNotEnded.db.test.ts` pins it
 * against real MySQL rather than against this reasoning.
 *
 * It is written as a comparison rather than as `endDate: { not: null }` plus a
 * bound for the same reason: one term that is already exact beats two that
 * have to agree.
 */
export const coopHasNotEndedFilter = (
  now: Date = new Date(),
): Prisma.CarpoolSearchWhereInput => ({
  endDate: { gte: coopLivenessBoundary(now) },
});

/**
 * The raw-SQL rendering of the floor, as a parenthesised fragment to `AND`
 * into a `WHERE`.
 *
 * `alias` names the `carpool_search` table in the surrounding query and is
 * interpolated with `Prisma.raw`, because an identifier cannot be a bound
 * parameter. **It must be a literal from this repository's own source** — it
 * is never derived from input, and the one caller passes `"cs"`. The boundary
 * itself is bound normally.
 *
 * `end_date` rather than `endDate`: raw SQL bypasses Prisma's field mapping,
 * and this column is `@map`ped.
 */
export const coopHasNotEndedSql = (
  alias: string,
  now: Date = new Date(),
): Prisma.Sql => {
  const endDate = Prisma.raw(`${alias}.end_date`);

  return Prisma.sql`(${endDate} >= ${coopLivenessDay(now)})`;
};

/**
 * The Prisma rendering of the ceiling: searches whose `end_date` falls inside
 * `coopYearBounds`.
 *
 * `lt`, matching the exclusive boundary — `coopYearCeilingBoundary` is the
 * first instant that is *too late*, so a co-op ending on 31 December of the
 * ceiling year survives. A dateless row is excluded here too, by the same
 * comparison and for the same reason as the floor's: both halves agree about
 * nulls, so composing them cannot reverse the decision either way.
 */
export const coopEndsBeforeYearCeilingFilter = (
  now: Date = new Date(),
): Prisma.CarpoolSearchWhereInput => ({
  endDate: { lt: coopYearCeilingBoundary(now) },
});

/**
 * The raw-SQL rendering of the ceiling. `alias` is interpolated under the same
 * rule `coopHasNotEndedSql` states, and the day is bound normally.
 */
export const coopEndsBeforeYearCeilingSql = (
  alias: string,
  now: Date = new Date(),
): Prisma.Sql => {
  const endDate = Prisma.raw(`${alias}.end_date`);

  return Prisma.sql`(${endDate} < ${coopYearCeilingDay(now)})`;
};

/**
 * Liveness itself: the floor and the ceiling together. **This is what callers
 * want** — the two halves are exported for their own tests and for readers,
 * not so a query can pick one.
 *
 * `AND` of the two halves rather than one merged `endDate: { gte, lt }`, so
 * each half stays exactly the predicate its own tests assert and composing
 * them cannot quietly rewrite either. The merged form would read the same
 * today and would put both boundaries back in one place for a later edit to
 * get half-right.
 */
export const coopIsLiveFilter = (
  now: Date = new Date(),
): Prisma.CarpoolSearchWhereInput => ({
  AND: [coopHasNotEndedFilter(now), coopEndsBeforeYearCeilingFilter(now)],
});

/**
 * The raw-SQL rendering of liveness. Both halves are already parenthesised and
 * the whole is parenthesised again. Neither half contains an `OR` any more, so
 * nothing can escape into a surrounding `AND` — the brackets are kept because
 * the property should hold whatever the halves grow into, not because today's
 * two comparisons need them.
 */
export const coopIsLiveSql = (
  alias: string,
  now: Date = new Date(),
): Prisma.Sql =>
  Prisma.sql`(${coopHasNotEndedSql(alias, now)} AND ${coopEndsBeforeYearCeilingSql(alias, now)})`;
