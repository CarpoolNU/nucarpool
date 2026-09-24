# Product decision: post-match feedback

**Status:** decision record. SCRUM-534. No production code changes.
**Evidence base:** `origin/main` at dafc040, plus read-only counts against
production `main` via the `reader` role.

SCRUM-534 asks whether to collect a trust signal after a carpool pairing ends,
and offers two shapes: **(a)** a private thumbs-up/thumbs-down per completed
membership, aggregated for admins, or **(b)** a star rating shown to future
prospective matches. Its first acceptance criterion is that the choice be
recorded before anything is built.

This document records that choice: **option (a), admin-only, and not built
yet.** Option (b) is rejected outright rather than deferred. The reasoning
below is mostly not about privacy preference — it is about two things the
codebase and the production data settle on their own.

## Contents

- [What the data says](#what-the-data-says)
- [Nothing records that two users carpooled](#nothing-records-that-two-users-carpooled)
- [At this group size, aggregate does not mean anonymous](#at-this-group-size-aggregate-does-not-mean-anonymous)
- [Options](#options)
- [Decision](#decision)
- [What building option (a) would involve](#what-building-option-a-would-involve)
- [Open questions](#open-questions)
- [Follow-up](#follow-up)

## What the data says

Read-only, against production `main`:

| Measure                                   | Count |
| ----------------------------------------- | ----: |
| `group` rows (carpools existing now)      |    49 |
| `carpool_search` rows with a `carpoolId`  |   126 |
| `request` rows, all statuses              | 3,608 |
| `request` rows with `status = 'ACCEPTED'` |    69 |
| `request` rows with `status = 'PENDING'`  | 3,539 |
| `user` rows                               | 4,483 |

Group formation, by month of `group.dateCreated`, spans 2024-10 to 2026-09 —
19 distinct months with at least one group, across a 24-month window. These
timestamps are spread rather than bulk-stamped, so unlike `carpool_search`
they read as real.

**The throughput is about two groups a month.** 49 surviving groups over two
years. That is a floor, not the true formation rate, because a dissolved group
is deleted rather than marked — see the next section — so groups that formed
and ended are simply absent from the count. But it bounds the order of
magnitude, and the order of magnitude is single digits per month.

**Acceptance is rare.** 69 of 3,608 requests are `ACCEPTED` — 1.9%. This too
is a survivor count, since a deleted request leaves nothing behind. Even read
generously, the number of pairings this feature could ever collect feedback on
is in the low hundreds, lifetime, and a handful per month going forward.

That matters for the decision in a way that is easy to skip past: a trust
signal is only a signal if it accumulates. At four or five submissions a month,
spread across a user base of 4,483, the probability that an admin looking at any
particular user finds feedback on them is close to zero — and it stays close to
zero for years. The feature would be correct and empty.

## Nothing records that two users carpooled

This is the finding that constrains the design, and it is not what the ticket
assumes. SCRUM-534's second acceptance criterion says feedback should be
"tied to a specific past group membership, once per membership."

**There is no past group membership to tie anything to.** Membership is not a
record. It is `CarpoolSearch.carpoolId`, a nullable foreign key
([`schema.prisma:221`](../../prisma/schema.prisma#L221)). Every trace of a
pairing is removed at exactly the moment the pairing ends:

| Record of "these two carpooled"       | Survives the pairing ending?                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CarpoolGroup` row                    | **No.** Deleted when the driver dissolves the group ([`groups.ts:588`](../../src/server/router/user/groups.ts#L588)) and when membership drops to one ([`groups.ts:833`](../../src/server/router/user/groups.ts#L833)).                                                                  |
| `CarpoolSearch.carpoolId`             | **No.** Nulled on dissolve ([`groups.ts:574`](../../src/server/router/user/groups.ts#L574)), on removing a rider ([`groups.ts:807`](../../src/server/router/user/groups.ts#L807)), and for the last member left behind ([`groups.ts:830`](../../src/server/router/user/groups.ts#L830)). |
| `Request` with `status = 'ACCEPTED'`  | **No** — and this one is deliberate. See below.                                                                                                                                                                                                                                          |
| `Conversation` and its `Message` rows | **No.** `requests.delete` removes them with the request ([`requests.ts:686`](../../src/server/router/user/requests.ts#L686) onward).                                                                                                                                                     |

The `Request` row is the interesting case, because at first reading it looks
like the durable pairing record the feature needs. It is not, and the reason it
is not is a decision the codebase already made on purpose.

`requests.delete` refuses to delete an `ACCEPTED` request **only while both
users are still in the same group** ([`requests.ts:637`](../../src/server/router/user/requests.ts#L637)).
The comment above that guard states the intent directly: "A pair who once
carpooled and have since parted must still be able to clear the row"
([`requests.ts:587`](../../src/server/router/user/requests.ts#L587)). The guard
is scoped to `ACCEPTED` **and** grouped, not `ACCEPTED` alone, precisely so that
parting re-opens the ability to delete.

So the protection covers exactly the window in which feedback is _not_ yet
collectable, and lifts at exactly the moment it would be. Either party can then
erase the row unilaterally, from the UI, with no involvement from the other.

Two consequences follow, and both are load-bearing:

1. **Feedback cannot reference an existing record.** A `Feedback` model with a
   foreign key to `CarpoolGroup`, or to `Request`, points at a row that is
   likely to be gone before the feedback is submitted and is guaranteed to be
   deletable afterwards. Under `relationMode = "prisma"` the database will not
   catch this; the reference simply dangles, the way
   `Conversation.requestId` did before it was fixed.

2. **The feedback row has to become the durable record itself.** It must be
   written at the moment of parting — inside the transactions in `groups.ts`
   that today only null out `carpoolId` — and must carry a denormalised copy of
   whatever it needs: rater id, subject id, and a pairing identifier minted at
   that moment. Nothing can be joined back to later, because there will be
   nothing to join to.

That is a materially larger change than the ticket's "purely additive" framing
under Testing Requirements. It means touching three write paths in the most
transaction-sensitive file in the router, each of which carries a documented
history of having been got wrong before.

## At this group size, aggregate does not mean anonymous

SCRUM-534's third acceptance criterion: "Feedback is never attributable to a
specific rater in any UI a rated user can see (for option a)."

Group sizes in production:

| Members in group | Groups | Share |
| ---------------: | -----: | ----: |
|                2 |     31 | 63.3% |
|                3 |     12 | 24.5% |
|                4 |      2 |  4.1% |
|                5 |      4 |  8.2% |

**In 31 of 49 groups there is exactly one other person.** A user in a two-person
carpool who is shown any feedback at all — a count, an average, a single
thumbs-down, even the bare fact that feedback exists — knows with certainty who
left it. Aggregation cannot fix this. There is nothing to aggregate over.

Adding the 3-member groups, 43 of 49 — **88%** — have at most two possible
raters, which is not meaningfully better: one negative signal out of at most two
raters narrows to a coin flip, and to a certainty if the other rater is known to
be friendly.

The criterion is therefore satisfiable only in its strictest reading: the rated
user sees **nothing**, ever, in any surface. Not a badge, not a count, not a
notification that feedback was received, not a change in how they are ranked
that they could detect by observation. Option (a) is viable only as a
write-only-to-admins channel.

This is worth stating explicitly because the natural product instinct — "show
people their own rating so they can improve" — is not available here at any
group size the app actually produces, and would silently violate the criterion
the ticket set.

## Options

### Option (a) — Private thumbs up/down, admin-only

As scoped in the ticket, with the constraint above made explicit: nothing is
ever surfaced to the rated user.

Costs what the previous two sections describe: a new model, a migration and a
PlanetScale deploy request, writes added to three transactions in `groups.ts`,
and a submission surface. Yields a handful of data points a month.

Privacy holds, but only under the strict reading, and only if the admin surface
also resists deanonymisation — an admin viewing "1 negative" on a user who had
exactly one carpool partner has learned that partner's opinion by name, which
is fine for admins and not fine if that view is ever widened.

### Option (b) — Star rating visible to prospective matches

Rejected. Three independent reasons, any one of which is sufficient:

- **The retaliation problem the ticket already flags is worse at this scale.**
  With single-digit pairings per user, one retaliatory one-star rating is not
  diluted by anything. It is the user's entire public record, permanently, and
  there is no volume of later ratings that could realistically outweigh it.
- **It cannot be anonymous.** Everything in the section above applies, and
  option (b) additionally surfaces the score to third parties, so the
  deanonymisation is not confined to the two people involved.
- **The displayed score would be absent for essentially everyone.** 4,483 users,
  low-hundreds of lifetime pairings. A rating shown on a match card would be
  blank on almost every card, and a card showing "no rating" next to one showing
  "2 stars" is a worse signal than showing nothing at all — it converts absence
  of data into an apparent judgement.

### Option (c) — Do not build a feedback channel; rely on reporting

Not in the ticket, but it is the honest third option and it is what the
recommendation partly adopts.

SCRUM-532 (report and block, **High**) covers the actual harm case — an unsafe
or uncomfortable interaction — and covers it better, because a report is filed
while the interaction is live rather than after every trace of it has been
deleted. It needs no durable pairing record and no changes to the group
transactions. SCRUM-533 (admin suspension, **High**) gives it a resolution
action.

A feedback channel is a strictly weaker instrument for the same goal: it asks
users to volunteer a rating about a relationship that has already ended, at a
moment when they have no reason to open the app again.

## Decision

**Option (a), and not built yet.**

Recorded so that SCRUM-534's first acceptance criterion is met and option (b) is
closed rather than left open:

1. **If a feedback channel is built, it is option (a)** — private, binary,
   visible only to admins, never surfaced to the rated user in any form,
   including indirectly. Option (b) is rejected, not deferred.
2. **It is not built now.** The signal would be sparse to the point of
   uselessness at ~2 group formations a month, and it would cost a schema
   change plus writes inside three transactions in `groups.ts` to collect it.
3. **The trigger for revisiting**, either of:
   - SCRUM-532 ships and its report queue shows a recurring problem that
     reporting does not capture — that is, admins repeatedly want to know
     "was this person difficult?" about someone nobody reported; or
   - group formation rises to a level where feedback would accumulate into
     something an admin could act on. On the current distribution that is
     roughly an order of magnitude — tens of groups a month rather than two.
4. **If it is ever built, the pairing record comes first.** The prerequisite is
   not the `Feedback` model. It is having any durable record that two users
   carpooled, which the app deliberately does not keep today. That is a change
   to `groups.ts`'s teardown semantics and should be designed as its own piece
   of work, because it also affects what the admin dashboard can report on
   historically.

Point 4 is the part most likely to be forgotten. Filing the `Feedback` model
without it produces a table whose rows reference nothing.

## What building option (a) would involve

Recorded so the follow-up ticket does not have to rediscover it.

**Schema.** A `Feedback` model, self-contained by necessity:

- `raterId`, `subjectId` — both `String`, both indexed. Not relation scalars
  pointing at `CarpoolGroup`; there will be no group row to point at.
- A pairing identifier minted at parting time, so "once per membership" is
  enforceable. A `@@unique([raterId, subjectId, pairingId])` gives the
  constraint the ticket asks for; without a `pairingId` the honest constraint is
  `@@unique([raterId, subjectId])`, which means once per _pair_ forever rather
  than once per membership, and would silently block feedback if the same two
  people carpool again in a later term.
- `relationMode = "prisma"` means every relation scalar needs an explicit
  `@@index` — see CLAUDE.md's Conventions section.
- Migration committed to `prisma/migrations/`, plus a separate PlanetScale
  `db push` to staging and a Deploy Request to `main`. These are two different
  things; see [the db README](../../src/server/db/README.md#changing-the-schema).

**Write path.** The parting moment is three places, not one:
[`groups.ts:588`](../../src/server/router/user/groups.ts#L588) (driver
dissolves), [`groups.ts:807`](../../src/server/router/user/groups.ts#L807)
(rider removed or leaves), and
[`groups.ts:833`](../../src/server/router/user/groups.ts#L833) (group falls to
one member). All three are inside transactions whose ordering is already
load-bearing and documented in place.

**Read path.** `adminRouter` only, alongside `getAuditLog`. Derive the acting
user from `ctx.session`, never from input — authentication is not
authorization, and a mutation naming a `subjectId` is exactly the shape that
rule exists for.

**Tests.** Unit coverage of the once-per-membership constraint, and a
`yarn test:db` integration test for persistence — the unit suite runs on a mock,
so a uniqueness assertion there only asserts that the mock implements
uniqueness.

## Open questions

Deliberately unanswered; they belong to whoever picks up the follow-up.

- **Is a durable pairing record wanted for its own sake?** The admin dashboard
  currently cannot answer "how many carpools has this app ever formed" — 49 is
  how many exist _now_. That may be worth fixing independently of feedback, and
  if it is fixed, feedback becomes much cheaper to add afterwards.
- **What is the retention period?** Feedback about a person, held indefinitely,
  with no route for them to see or contest it, is a different thing at one year
  than at five. Nothing in the app currently deletes user-associated records on
  a schedule.
- **Who counts as admin here?** `adminRouter` admits `ADMIN` and `MANAGER`
  alike. Unattributable-to-the-subject is not the same as unattributable to
  every staff member, and at 63% two-person groups the distinction collapses.
- **Does the rater get told anything?** Even a confirmation that their feedback
  was recorded is a surface, and surfaces leak. Probably yes, but it should be
  a decision rather than an accident.

## Follow-up

- **SCRUM-545** — implement option (a), including the durable pairing record it
  depends on. Left in `To Do`; it should not be started before one of the
  triggers in [Decision](#decision) point 3 fires.
- SCRUM-534 is satisfied by this document: the product decision is recorded,
  and the two conditional criteria are carried into the follow-up unchanged.
