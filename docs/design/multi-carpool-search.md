# Design spike: lifting the one-`CarpoolSearch`-per-user assumption

**Status:** design only. SCRUM-543. No production code changes.
**Evidence base:** `origin/main` at 47c720e, plus a read-only count against production.

`schema.prisma` lets a `User` have many `CarpoolSearch` rows. The application
assumes exactly one, everywhere. This document inventories that assumption,
classifies it, and proposes which of three designs to build — so that a feature
wanting more than one search context per user does not start by discovering the
scope mid-implementation.

## Contents

- [What the data says](#what-the-data-says)
- [The assumption is not one pattern, it is four](#the-assumption-is-not-one-pattern-it-is-four)
- [Inventory](#inventory)
- [The real obstacle is identity, not the flatten site](#the-real-obstacle-is-identity-not-the-flatten-site)
- [A defect found on the way](#a-defect-found-on-the-way)
- [Options](#options)
- [Recommendation](#recommendation)
- [Schema and migration implications](#schema-and-migration-implications)
- [Open questions](#open-questions)

## What the data says

Read-only, against production `main`, via the `reader` role:

| Measure                               | Count |
| ------------------------------------- | ----: |
| `carpool_search` rows                 | 4,183 |
| Distinct `userId` in `carpool_search` | 4,183 |
| Users with **more than one** search   | **0** |
| Users with **no** search              |   299 |
| `user` rows                           | 4,482 |

Two things follow, and they pull in opposite directions.

**The assumption is true in the data today.** Not approximately — exactly. There
is no drift to clean up, no backfill to plan, and a `@@unique([userId])`
constraint would apply to production right now without a single row needing
repair. Any design below starts from a clean base.

**The case that is real is _zero_ searches, not two.** 299 users — 6.7% — have
no `CarpoolSearch` at all. That is the case the `?? VIEWER` / `?? 0` / `?? ""`
fallbacks in `user.me` exist for, and the case `hasCarpoolSearch` (SCRUM-508)
was added to distinguish. Work on this ticket must not regress it: every option
below has to keep "no search" distinguishable from "a search whose values happen
to be the defaults".

## The assumption is not one pattern, it is four

The ticket names `findFirst` and `carpoolSearches[0]`. Those are the visible
class. There are three more, and two of them are considerably more dangerous,
because they fail by writing rather than by reading.

**Class A — Selection.** "Get the user's search." `findFirst({ where: { userId } })`,
`carpoolSearches[0]`, `take: 1`. Under multi-search these return an arbitrary
row. Loud and easy to find; this is the class the ticket describes.

**Class B — Fan-out join.** `findMany({ where: { userId: { in: [...] } } })`
followed by `.find((s) => s.userId === x)`. These assume the result set is a
_bijection_ with the input user ids. Under multi-search the query returns more
rows than there were ids, and `.find` silently takes whichever came back first.
No error, no duplicate key, just a wrong row.

**Class C — Unscoped write by `userId`.** `updateMany({ where: { userId } })`.
Today this means "update the one row". Under multi-search it means "update
**every** row", which is neither what any caller intends nor something the type
system or the database will object to. This is the class that corrupts data.

**Class D — Already correct.** Code keyed on `carpoolId`, on `carpoolSearchId`,
or written row-oriented from the start. It needs no change at all. Class D is
larger than expected and includes the whole matching engine, which matters for
sequencing — see [Options](#options).

## Inventory

Line numbers are against 47c720e.

### Class A — Selection (16 sites)

| Site                                              | What it selects                                         | Notes                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/server/router/user.ts:104`                   | `user.carpoolSearches[0]`                               | The `user.me` flatten. The one the rest of the app is typed against.                       |
| `src/server/router/user.ts:286`                   | `tx.carpoolSearch.findFirst({ where: { userId: id } })` | `user.edit`'s find-or-create. See [A defect found on the way](#a-defect-found-on-the-way). |
| `src/server/router/user/groups.ts:292`            | caller's search                                         | `groups.me`; reads `carpoolId` off it to find the group.                                   |
| `src/server/router/user/groups.ts:413`            | `input.driverId`'s search                               | `groups.create`; role/status/group guard.                                                  |
| `src/server/router/user/groups.ts:425`            | `input.riderId`'s search                                | `groups.create`; same.                                                                     |
| `src/server/router/user/groups.ts:733`            | `input.riderId`'s search                                | `groups.edit` add path; same.                                                              |
| `src/server/router/user/groups.ts:931`            | caller's search                                         | `updatePreferences` — writes to it. See below.                                             |
| `src/server/router/user/requests.ts:121`          | caller's search                                         | `requests.me`; becomes the caller's own card on both sides.                                |
| `src/server/router/user/favorites.ts:22`          | caller's search                                         | Existence guard only; `role` is selected but no longer used.                               |
| `src/server/router/user/recommendations.ts:43`    | caller's search                                         | Seeds `fetchRankedCandidates`.                                                             |
| `src/server/router/mapbox.ts:173`                 | caller's search                                         | Seeds `fetchRankedCandidates` for `geoJsonUserList`.                                       |
| `src/server/router/user/email.ts:125`             | any user's search                                       | `isDriver`; decides which SES template is sent.                                            |
| `src/server/router/user/admin.ts:219`             | `FIRST_SEARCH` (`take: 1`)                              | `getDashboardSeries`, user status.                                                         |
| `src/server/router/user/admin.ts:232`             | `FIRST_SEARCH`                                          | `getDashboardSeries`, requester role.                                                      |
| `src/server/router/user/admin.ts:289`             | `FIRST_SEARCH`                                          | `getDashboardStats`, the user-counts matrix.                                               |
| `src/server/router/user/admin.ts:242,245,251,304` | `carpoolSearches[0]`                                    | Reads of the three selects above.                                                          |

**None of these 16 sites has an `orderBy`.** Not one. So "the first search" is
not merely assumed unique — it is _undefined_ if it ever is not. On Vitess,
where row order is not even locally stable, two endpoints could disagree about
the same user within one page load. Whatever design is chosen, the disambiguator
has to be explicit; adding `orderBy` alone would make the choice deterministic
but still arbitrary.

One pair deserves separate mention. `groups.updatePreferences`
(`groups.ts:931`) **writes** the driver's ride preferences to the search it
picks by `userId`. `groups.me` (`groups.ts:346`) **reads** them back through
`memberCarpoolSearches.find((s) => s.role === DRIVER)` — a row selected by
`carpoolId`. Today those are the same row by necessity. Under multi-search they
are two independently-chosen rows, so a driver could save preferences that their
own group never displays, with both endpoints reporting success.

### Class B — Fan-out join (5 sites)

| Site                                              | Shape                           | Consequence under multi-search                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/router/user/requests.ts:149` → `:207` | sent-request counterparts       | `.find` picks an arbitrary search; the card shows one context's role/seats/schedule for a request that was about another.                                                                                               |
| `src/server/router/user/requests.ts:170` → `:220` | received-request counterparts   | Same.                                                                                                                                                                                                                   |
| `src/server/router/user/requests.ts:340`          | `searches.find(...)?.carpoolId` | The "already carpooling together" guard. A user in two groups resolves to an arbitrary one, so the guard both false-negatives and false-positives.                                                                      |
| `src/server/router/user/requests.ts:617`          | `searches.find(...)?.carpoolId` | Same guard on the conversation-delete path.                                                                                                                                                                             |
| `src/server/router/user/favorites.ts:52` → `:93`  | one card per row                | Not arbitrary — **duplicated**. `findMany` by `userId: { in: [...] }` returns N rows for a favourite with N searches, and each is mapped to its own card. The un-favourite star on every copy targets the same user id. |

Favorites is the clearest illustration that Class B is not a variant of Class A.
Class A picks the wrong row; favorites renders _all_ of them, and the list grows
without anything having been favourited.

### Class C — Unscoped write by `userId` (5 sites)

| Site                                   | Statement                                                                                                     | Consequence under multi-search                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/router/user/groups.ts:252` | `reserveSeat`: `updateMany({ where: { userId, seatsAvail: SEAT_AVAILABLE_FILTER }, data: { decrement: 1 } })` | Decrements **every** search of the driver that has a seat. The compare-and-swap still guards against going negative per row, but one rider joining costs the driver one seat in each context. |
| `src/server/router/user/groups.ts:520` | driver `carpoolId` ← `group.id`                                                                               | Joins all of the driver's searches to the new group.                                                                                                                                          |
| `src/server/router/user/groups.ts:526` | rider `carpoolId` ← `group.id`                                                                                | Joins all of the rider's searches.                                                                                                                                                            |
| `src/server/router/user/groups.ts:785` | rider `carpoolId` ← `input.groupId`                                                                           | Same, on the `groups.edit` add path.                                                                                                                                                          |
| `src/server/router/user/groups.ts:805` | rider `carpoolId` ← `null`                                                                                    | Removes the rider from **all** their groups, not the one named.                                                                                                                               |

`reserveSeat` is worth dwelling on. Its correctness argument — documented at
`groups.ts:236–249` — is that the compare-and-swap makes the decrement atomic
and non-negative. That argument is about _concurrency_ and remains sound. It
says nothing about _cardinality_, and the `where` clause silently changes
meaning from "the row" to "the rows" the moment a second search exists. It is
the sharpest example of why this cannot be done as a mechanical sweep: the code
is correct, well-reasoned and commented, and still wrong under the new
cardinality.

### Class D — Already multi-search-correct (no change needed)

Listed because it is the part of the sequencing argument that is easy to miss.

- **The matching engine.** `buildCandidateWhere` and `fetchRankedCandidates`
  (`src/server/db/candidateSearch.ts:257,404`) query `carpoolSearch` rows
  directly and filter on row columns. They are already row-oriented and would
  match per-context without modification.
- **Group membership.** `carpoolId` lives on `CarpoolSearch`, so membership is
  _already_ a per-search fact. Everything keyed on it is safe:
  `membershipOf` (`groups.ts:87`, `{ userId, carpoolId }` — scoped, so correct
  even though it is a `findFirst`), `groups.ts:320,560,691,799,812,828,884`,
  and `releaseSeats` (`groups.ts:274`, keyed by search id).
- **Location ownership.** `src/server/db/locationOwnership.ts:67` keys on
  `carpoolSearchId` throughout. A second search would get its own pair of
  `Location` rows with no change.
- **Admin group aggregates.** `MIXED_ROLE_GROUP` (`admin.ts:56`) uses
  `carpoolSearches: { some: ... }`, which is cardinality-agnostic.
- **Repair scripts.** `repair-seat-residue.ts`, `check-driverless-groups.ts`
  and `cleanup-orphan-locations.ts` are group- or row-keyed.

## The real obstacle is identity, not the flatten site

The ticket frames the work around `user.me`'s flattened shape and `types.ts`.
Those are real, but they are the tractable part. The obstacle is one line:

```ts
// src/server/publicUser.ts:53, inside buildPublicUser
id: search.user.id,
```

`PublicUser` — the type every matching surface is built from — takes its `id`
from the **user**, and every other field from the **search**: `role`, `status`,
`seatAvail`, `companyName`, `daysWorking`, `startTime`/`endTime`,
`coopStartDate`/`coopEndDate`, both locations, `carpoolId`.

So `PublicUser` is user-identified and search-valued. With one search that is a
harmless simplification. With two it is a type whose identity does not determine
its contents: two `PublicUser` objects, same `id`, different payloads. And the
entire client is keyed on that `id`:

- React list keys — `SidebarContent.tsx:129,141,154,167,180,191`,
  `MapConnectPortal.tsx:154`, `GroupMemberCard.tsx:119`,
  `MessageHeader.tsx:406,480`. Duplicate keys, and React reconciles two distinct
  cards as one.
- Map features — `mapbox.ts:241` spreads the whole `PublicUser` into GeoJSON
  `properties`. Two searches at the same company produce two pins that are
  indistinguishable downstream.
- Selection — `selectedUserId` in `src/pages/index.tsx:514`, and the
  request/favourite join in `extendPublicUser` (`index.tsx:484–495`), all match
  on user id.
- Mutation targets — `toId` (`ConnectModal.tsx:119`), `favoriteId`
  (`UserCard.tsx:125`), `driverId`/`riderId` (`GroupMemberCard.tsx:82`) are all
  user ids. A request sent from a per-context card cannot say which context it
  was about.

Two of the three relationships are user-to-user in the schema as well:
`Request.fromUserId`/`toUserId`, and `_Favorites`, which is a `User`↔`User`
implicit many-to-many. Group membership is the exception — it is already
per-search.

**This is the decision the spike exists to make.** Not "how do we pick a search"
but "is the thing a user matches with a _person_ or a _search_?" Everything else
follows from it.

## A defect found on the way

`user.edit`'s find-or-create (`src/server/router/user.ts:286–366`) reads with
`findFirst` and branches to `create` when nothing is found. It runs inside an
interactive transaction, but **there is no unique constraint on
`carpool_search.userId`** — `@@index([userId])` is non-unique. Under MySQL's
default isolation there is no row and therefore no gap lock to serialise on, so
two concurrent first-time profile saves for the same user can both read null and
both insert.

That means a second `CarpoolSearch` is reachable **today**, by accident, with no
feature work at all — and if one ever appears, the 16 unordered Class A sites
start disagreeing with each other non-deterministically.

This reframes the constraint in Phase 1 below: it is a defect fix first and a
design foundation second. It is _not_ filed as a separate ticket, because the
fix and the first phase of this design are the same change — adding
`@@unique([userId])` is simultaneously the guard against the race and the
decision to defer multi-search. Splitting them would produce two tickets that
must land as one commit.

Production has 0 duplicates, so the race has not fired, or has not fired
observably.

## Options

### Option 1 — Enforce one search per user

Add `@@unique([userId])` to `CarpoolSearch`. Classes A, B and C become provably
correct rather than correct by convention — `findFirst` returns _the_ row by
construction, the fan-out joins really are bijections, and `updateMany` by
`userId` really does touch one row. The find-or-create race closes.

Cost: near zero — 0 violating rows today. Forecloses multi-context matching
entirely until reversed.

### Option 2 — One _active_ search, many stored

Add an explicit pointer: `User.activeCarpoolSearchId`, or a
`CarpoolSearch.isActive` flag with a partial-unique discipline. Class A reads
the pointer. Class B and C scope their `where` clauses by it. `PublicUser`,
`types.ts` and the whole frontend are unchanged, because exactly one search is
ever live.

Buys: switching contexts between co-op terms; history retained rather than
overwritten by `user.edit`.

Does **not** buy: the ticket's own motivating example — rider outbound and
driver on the return — because that needs two searches live _at once_.
MySQL cannot express "one active row per user" as a partial unique index, so the
invariant stays application-enforced, which is the same class of problem this
document is about.

### Option 3 — The search is the matching entity

`PublicUser` gains a search id and is keyed by it. Requests and favourites move
from user-to-user to search-to-search. The frontend lists search contexts. The
matching engine and group membership need no change — they are already there
(Class D).

Buys: everything, including genuinely concurrent contexts.

Cost: the largest. Beyond the 26 sites above, it needs migrations on `Request`
and `_Favorites`, backfill of both (~every existing request and favourite must
be pointed at the user's single search — mechanical, since there is exactly one),
and UI design work that does not exist yet: nothing in the product currently
expresses "which of my searches is this about". The messaging system is
conversation-per-request, so threads inherit whatever is decided for requests.

### Option 4 — Rejected

Per-context searches with user-keyed matching and a UI selector. Keeps the
identity ambiguity while adding storage complexity, and leaves Class B and C
exactly as wrong as they are now. Recorded only so it is not re-proposed.

## Recommendation

**Adopt Option 1 now. Design Option 3 when a feature actually requires it. Do
not build Option 2.**

The reasoning:

1. **Nothing currently needs multi-search.** The ticket says so, and the data
   agrees — 0 users have a second search. Option 2 is the only one that could be
   built speculatively, and it is the one that does not satisfy the motivating
   use case. Building it would add a pointer, a migration and an
   application-enforced invariant in exchange for a capability nobody has asked
   for, and would then have to be unwound to reach Option 3.
2. **The unique constraint has independent value today.** It closes a live race
   (above) and converts 16 unordered lookups from "assumed unique" to
   "guaranteed unique" at the cost of one schema line and zero row repairs. That
   is worth doing whether or not multi-search is ever built.
3. **It makes Option 3 _cheaper_, not more expensive.** The constraint is a
   one-line removal. What survives it is the inventory in this document, the
   Class B/C classification, and the identity analysis — which is the expensive
   part and is done now. Dropping a constraint is not the obstacle to
   multi-search; deciding what `PublicUser.id` means is.
4. **Class D is already done.** When Option 3 is built, the matching engine and
   group membership need no work. That is a significant head start, and it is
   only visible because the sweep distinguished Class D from the rest.

The risk this accepts: if multi-context matching becomes a near-term priority,
Phase 1 is a small amount of rework (one migration reverted). That is a better
trade than Option 2's speculative half-measure.

## Schema and migration implications

For Phase 1 (`@@unique([userId])`):

- Per [the db README](../../src/server/db/README.md#changing-the-schema), this
  is **two separate things**: a committed migration in `prisma/migrations/`, and
  a PlanetScale `db push` to staging plus a Deploy Request to `main`. Migration
  files are never applied to PlanetScale.
- `relationMode = "prisma"` means foreign keys are emulated, but **unique
  constraints are real MySQL indexes** and are enforced by the database. The
  guarantee is genuine, not application-level.
- The existing non-unique `@@index([userId])` becomes redundant — a unique index
  on the same single column serves the same lookups. Dropping it is optional and
  should be a separate decision, since index changes on a 4,183-row table are
  cheap but Deploy Requests are not free.
- **Backfill: none.** 0 violating rows. The Deploy Request will not fail on
  existing data. This should still be re-verified immediately before the deploy,
  since the race above means a duplicate could in principle appear at any time.
- `user.edit` should additionally catch `P2002` on the `create` branch and retry
  as an update, so the race surfaces as a successful save rather than a 500.

For Phase 2 (Option 3), deferred: migrations on `Request` and `_Favorites`, a
backfill of both, and a decision on whether `Conversation` follows `Request`.

## Open questions

Deliberately unresolved — these belong to the Option 3 design, not to this
spike.

1. **Does a request target a person or a context?** If Ana has an outbound and a
   return search, does Ben send one request or two? This determines the
   `Request` migration and whether the messaging thread is per-person or
   per-context.
2. **Favourites: person or context?** `_Favorites` is user-to-user. Favouriting
   a person is arguably the correct semantics even in a multi-search world, in
   which case only the _rendering_ needs deduplicating, not the schema.
3. **Does `CANDIDATE_LIMIT` count rows or people?** `fetchRankedCandidates`
   takes `CANDIDATE_LIMIT + 1` rows to detect truncation. If one user can
   contribute several rows, the ceiling stops being a bound on how many _people_
   are offered.
4. **Is `excludedUserIds` still the right shape?** `mapbox.ts:198` and
   `recommendations.ts:68` exclude by user id — self, and anyone already
   messaged. Under Option 3, should a user's _other_ searches be excluded from
   their own results, and should messaging someone in one context hide them in
   all?
5. **What does the admin dashboard count?** `FIRST_SEARCH` produces one row per
   user. Under multi-search, "active users" and the role matrix have to choose
   between counting people and counting searches; the CSV export and the charts
   must agree on which.
6. **Which search owns group preferences?** `updatePreferences` picks by
   `userId`, `groups.me` reads by `carpoolId` + `DRIVER`. Under Option 3 the
   write must be scoped to the membership, not the user.

## Follow-up

SCRUM-544 implements Phase 1: `@@unique([userId])` in `schema.prisma`, migration
`20260925120000_unique_carpool_search_user`, and a retry in `user.edit`. The
race described above is reproduced deterministically in
`src/server/router/user.db.test.ts`. The redundant `@@index([userId])` was kept
and remains a separate decision. Option 3 gets its own
ticket if and when a feature requires it; this document is the input to that
design.
