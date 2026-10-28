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
 * **A null `end_date` is admitted. Deliberately.** By both halves, so
 * composing them does not quietly reverse the decision.
 *
 * A null cannot be compared, so the predicate must either admit the dateless
 * rows or exclude them, and SCRUM-631 left the choice to be made here on
 * measurement. Measured read-only against PlanetScale `main` on **2026-10-27**,
 * over the matchable pool (`status = ACTIVE`, `user.is_onboarded`, and a role
 * of DRIVER or RIDER — the floor every branch of the candidate query shares):
 *
 *   - **1,499** rows in the pool
 *   - **1,131** ended — what the floor removes
 *   - **324** still running
 *   - **44** dateless — what admitting them keeps
 *
 * The 1,489 dateless rows SCRUM-549 counted were taken over the raw `ACTIVE`
 * population, which on the same day held 3,088 rows of which **1,491 are
 * VIEWERs**. That is the whole discrepancy: the dateless cohort is almost
 * entirely VIEWERs, and `compatibleRoles` already excludes a VIEWER from
 * everyone's candidate set, so they were never in the pool to remove. The real
 * cost of admitting nulls is **44 rows**, not 1,489.
 *
 * So excluding them would buy 3% of the pool while silently hiding 44 riders
 * and drivers who simply never entered dates — people who may well be looking
 * for a carpool today. Admitting them keeps one effect that can be reasoned
 * about. The dateless cohort has its own ticket.
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
 * Nested under `OR` rather than written as `endDate: { not: { lt: boundary } }`
 * because SQL's three-valued logic drops a NULL out of a negation — `NOT (NULL
 * < x)` is NULL, which is not true, so the dateless rows this predicate means
 * to admit would be filtered out instead. The explicit `null` arm is the only
 * form that admits them.
 */
export const coopHasNotEndedFilter = (
  now: Date = new Date(),
): Prisma.CarpoolSearchWhereInput => ({
  OR: [{ endDate: null }, { endDate: { gte: coopLivenessBoundary(now) } }],
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

  return Prisma.sql`(${endDate} IS NULL OR ${endDate} >= ${coopLivenessDay(now)})`;
};

/**
 * The Prisma rendering of the ceiling: searches whose `end_date` falls inside
 * `coopYearBounds`.
 *
 * `lt`, matching the exclusive boundary — `coopYearCeilingBoundary` is the
 * first instant that is *too late*, so a co-op ending on 31 December of the
 * ceiling year survives. The `null` arm is the same decision, and carries the
 * same three-valued-logic reason, as the floor's.
 */
export const coopEndsBeforeYearCeilingFilter = (
  now: Date = new Date(),
): Prisma.CarpoolSearchWhereInput => ({
  OR: [{ endDate: null }, { endDate: { lt: coopYearCeilingBoundary(now) } }],
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

  return Prisma.sql`(${endDate} IS NULL OR ${endDate} < ${coopYearCeilingDay(now)})`;
};

/**
 * Liveness itself: the floor and the ceiling together. **This is what callers
 * want** — the two halves are exported for their own tests and for readers,
 * not so a query can pick one.
 *
 * `AND` rather than one merged `OR`, so each half stays the predicate its own
 * tests assert and composing them cannot quietly rewrite either.
 */
export const coopIsLiveFilter = (
  now: Date = new Date(),
): Prisma.CarpoolSearchWhereInput => ({
  AND: [coopHasNotEndedFilter(now), coopEndsBeforeYearCeilingFilter(now)],
});

/**
 * The raw-SQL rendering of liveness. Both halves are already parenthesised and
 * the whole is parenthesised again, so `AND`ing it into a `WHERE` that has
 * other terms cannot let either internal `OR` escape.
 */
export const coopIsLiveSql = (
  alias: string,
  now: Date = new Date(),
): Prisma.Sql =>
  Prisma.sql`(${coopHasNotEndedSql(alias, now)} AND ${coopEndsBeforeYearCeilingSql(alias, now)})`;
