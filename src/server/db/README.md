# Database Layer

This directory holds the Prisma client the rest of the app shares. The schema, migrations, and seed script live at the repository root in [`prisma/`](../../../prisma).

- [`client.ts`](./client.ts) — creates and exports the `PrismaClient` singleton
- [`../../../prisma/schema.prisma`](../../../prisma/schema.prisma) — the data model
- [`../../../prisma/migrations/`](../../../prisma/migrations) — ordered SQL migrations
- [`../../../prisma/seed.ts`](../../../prisma/seed.ts) — generated data for local development. **Destructive**: it deletes every row from six tables before inserting. [`../../utils/seedGuard.ts`](../../utils/seedGuard.ts) refuses to run it against any host outside a local allowlist; see [Seeding resets your local data](../../../README.md#seeding-resets-your-local-data).

## The client

[`client.ts`](./client.ts) caches the client on `global` outside production, so Next.js hot reloading doesn't open a new connection pool on every reload. Import this module rather than constructing `new PrismaClient()` anywhere else.

Application code doesn't import it directly — it reaches the database through the tRPC context as `ctx.prisma`:

```typescript
me: protectedRouter.query(async ({ ctx }) => {
  return ctx.prisma.user.findUnique({
    where: { id: ctx.session.user?.id },
    include: { carpoolSearches: true },
  });
}),
```

See the [router README](../router/README.md) for how that context is built.

## Schema notes

- **A user's carpool details are not on `User`.** `User` holds identity and profile fields only. Role, company, schedule, seats, status, and group membership live on `CarpoolSearch`, which links to two `Location` rows (home and company). `user.me` merges the first `CarpoolSearch` back onto the returned user object for backwards compatibility, so a flat-looking result does not mean flat storage.
- **A `Location` belongs to one slot of one `CarpoolSearch`.** Home and company rows are never shared between users, and never shared between a single user's own two slots. Anything writing locations must go through [`locationOwnership.ts`](./locationOwnership.ts) rather than reaching for `prisma.location` directly — see [Location ownership](#location-ownership) below.
- **`relationMode = "prisma"`** — foreign keys are emulated by Prisma instead of enforced by the database. Relation scalar fields therefore need explicit `@@index` entries, and `onDelete: Cascade` is carried out by Prisma, not MySQL.
- `Account`, `Session`, `User`, and `VerificationToken` back NextAuth through the Prisma adapter. Changing them can break sign-in.

## Dates and times

Two columns on `CarpoolSearch` store a moment without a zone, so the convention matters.

**Schedule times — `startTime` / `endTime` (`DateTime? @db.Time(0)`)**

A time of day in **UTC**, with no date attached. `user.edit` parses the ISO string the client sends and Prisma writes the UTC time of day out of it, so a student picking 9:00 AM in Boston is stored as `14:00:00`.

Render with [`formatScheduleTime`](../../utils/scheduleTime.ts), which converts to `America/New_York`. Every schedule time in the UI goes through that one helper — do not format these columns inline. `UserCard` and `ConnectModal` each used to carry a copy that reinterpreted the value as UTC when the Boston hour fell between 01:00 and 04:59, which was a guess about rows predating the standardisation on UTC and mislabelled genuine early shifts.

Boston is hardcoded because the product is Northeastern co-op students; a schedule has no meaning in the viewer's own zone.

**An overnight shift is legal, and deliberately unvalidated.** These are two times of day, not a range, so nothing requires the second to come after the first: a night shift starting at 22:00 and finishing at 06:00 stores exactly that, and it is correct. [`minutesApart`](../../utils/recommendation.ts) measures the gap between two people's times the short way round the clock — `min(d, 1440 - d)` — so an overnight pair is scored properly rather than merely tolerated, and nothing in the scorer or in [`buildCandidateWhere`](./candidateSearch.ts) compares a user's own start against their own end. Contrast the co-op columns below, which **are** a range and are checked.

**Co-op dates — `startDate` / `endDate` (`DateTime? @db.Date`)**

A calendar day, taken by Prisma from the **UTC** date of whatever `Date` it is handed. Build these with [`lastDayOfMonthUTC`](../../utils/dateUtils.ts) rather than `new Date(year, month, 0)`: the local-time form stored the previous day for anyone at a positive UTC offset, because local midnight is the day before in UTC.

**The range has to run forwards.** A reversed one was stored as submitted and then failed silently at match time: `dateOverlapFilter`'s full-overlap branch asks for `startDate <= theirs AND endDate >= theirs`, which no candidate can satisfy once the two are crossed, so the user disappeared from every full-overlap search with nothing to say why, and the partial-overlap negation behaved arbitrarily. `user.edit` and [`onboardSchema`](../../utils/profile/zodSchema.ts) both refuse `endDate < startDate` now, through the shared [`isReversedCoopRange`](../../utils/dateUtils.ts).

**Equality is allowed**, and has to be: both pickers are month-granularity and `handleMonthChange` stores the _last day_ of the month chosen, so a one-month co-op is the same date twice.

## Coordinates

`location.coord_lat` and `coord_lng` are plain `Float` columns, so the database accepts any number at all — and out-of-range values do not fail downstream either, they merely stop meaning anything. `locationWithin` adds a degree delta to whatever centre it is given and `milesBetween` feeds the value through `Math.cos`, so a nonsense row is silently unmatchable rather than loud, and it is scanned for nothing by the `location_coord_lat_coord_lng_idx` bounding box.

Both are therefore bounded to WGS 84 at the boundary that writes them. The definitions live in [`utils/coordinates.ts`](../../utils/coordinates.ts), shared with `getDirections`, which range-checks its own input the same way.

**`(0, 0)` needs a separate rule.** It is inside the valid range, but it is the sentinel [`useAddressSelection`](../../utils/useAddressSelection.ts) starts at and resets to when the address input is cleared, so it means "no address picked yet" rather than a point in the Gulf of Guinea ~4000 miles from Boston. `user.edit` refuses it for every role except `VIEWER` — a VIEWER has no `Location` at all, and `user.me` already reports `(0, 0)` for a row without one. Only the exact pair is refused: longitude 0 is Greenwich and latitude 0 is the equator, and a row at one and not the other is a real place.

The forms check the same thing before saving, against the address hooks rather than the form fields. That distinction matters: `startAddress` and `companyAddress` hold address _text_, `ControlledAddressCombobox` writes back to the form only when a suggestion is chosen, and the coordinates never enter the form at all — so text left over from a previous save can sit next to `(0, 0)`.

### Rows that predate the check

[`scripts/check-profile-coordinates.ts`](../../../scripts/check-profile-coordinates.ts) reports them, along with reversed co-op ranges and searches pointing at a `Location` that no longer exists.

```bash
npx ts-node scripts/check-profile-coordinates.ts
```

It is read-only and has no `--apply`, deliberately: a lost coordinate cannot be re-derived without re-geocoding an address string that may itself be empty, and only the student knows which way round their own co-op runs. There is no correct value to write, so the remedy is to ask the affected users to re-save their profile — which the boundary now validates. A `VIEWER` at `(0, 0)` is not reported, since that is expected.

## Text lengths

MySQL runs in strict mode, so a value wider than its column makes the write **throw**, not truncate. Prisma surfaces that as `P2000` and tRPC turns it into an `INTERNAL_SERVER_ERROR` — a 500 for what is really a validation problem, raised after the UI has already accepted the text. Every Zod input that writes free text to a bounded column therefore carries a `.max()` matching that column.

An unannotated `String` on MySQL is `VARCHAR(191)`, which is why so many of these are 191 rather than something chosen.

| Column                                                  | Width          | Bounded by                                           | Limit                     |
| ------------------------------------------------------- | -------------- | ---------------------------------------------------- | ------------------------- |
| `message.content`                                       | `VARCHAR(255)` | `messages.sendMessage`, `requests.create`            | `MESSAGE_MAX_LENGTH`      |
| `user.bio`                                              | `VARCHAR(191)` | `user.edit`, `onboardSchema`                         | `PROFILE_TEXT_MAX_LENGTH` |
| `user.preferred_name`                                   | `VARCHAR(191)` | `user.edit`, `onboardSchema`                         | `PROFILE_TEXT_MAX_LENGTH` |
| `user.pronouns`                                         | `VARCHAR(191)` | `user.edit`, `onboardSchema`                         | `PROFILE_TEXT_MAX_LENGTH` |
| `carpool_search.company_name`                           | `VARCHAR(191)` | `user.edit`, `onboardSchema`                         | `PROFILE_TEXT_MAX_LENGTH` |
| `carpool_search.group_notes`                            | `VARCHAR(90)`  | `groups.updatePreferences`, the `GroupPage` textarea | `GROUP_NOTES_MAX_LENGTH`  |
| `carpool_search.group_music_preference`                 | `VARCHAR(40)`  | `groups.updatePreferences`                           | `GROUP_OPTION_MAX_LENGTH` |
| `carpool_search.group_conversation_style`               | `VARCHAR(40)`  | `groups.updatePreferences`                           | `GROUP_OPTION_MAX_LENGTH` |
| `carpool_search.group_message`                          | `TEXT`         | legacy, read-only — **see below**                    | —                         |
| `group.message`                                         | `VARCHAR(191)` | never written with content — **see below**           | —                         |
| `request.message`                                       | `VARCHAR(255)` | never written; `requests.create` stores `""`         | —                         |
| `location.street`, `.street_address`, `.city`, `.state` | `VARCHAR(191)` | — parsed from a Mapbox feature, not typed            | —                         |

The values live in [`textLimits.ts`](../../utils/textLimits.ts) so the form, the tRPC input and the column cannot drift apart. Add a `.max()` there and reference it; do not write the number inline.

### The two group-message columns are legacy

Group ride preferences used to be one `GROUP_DETAILS_V1:{…json…}` blob, written into `group.message` _and_ mirrored into `carpool_search.group_message`. That was replaced with the three real columns above, owned by the driver's own `CarpoolSearch`.

**Neither column needs widening, and neither should be.** An earlier version of this section said `group.message` could overflow and that restoring `@db.Text` was the fix — a migration and a PlanetScale deploy request for a column that is now written empty. That advice pointed the opposite way to the plan of record:

- **`group.message`** — [`groups.create`](../router/user/groups.ts) writes `""` and nothing reads it. There is no path that puts content in it, so its width is irrelevant.
- **`carpool_search.group_message`** — read-only, and only as a fallback. [`resolveGroupDetails`](../../components/Group/groupDetails.ts) treats all three `group_*` columns being null as "never saved" and parses the old blob out of this column instead, so a row that has not been backfilled still renders. Nothing writes it.

**Both should be dropped** once the real columns are deployed everywhere and [`scripts/backfill-group-preferences.ts`](../../../scripts/backfill-group-preferences.ts) has run. Until then they stay so that a schema deploy landing before the matching build cannot break the old code.

**As of 2026-08-31 the backfill is not finished, so dropping them is not yet safe.** Staging still holds 3 rows whose preferences exist only in `group_message`, and production is unknown — read access to the PlanetScale `main` branch was not available. The run-state table in [`scripts/README.md`](../../../scripts/README.md#run-state-record) is where that answer lives; check it, and the dry run, before dropping either column. While those rows exist, `resolveGroupDetails`'s fallback is the only thing keeping their content readable.

Lengths on the live path are enforced where every other one is: Zod on [`groups.updatePreferences`](../router/user/groups.ts), against the same constants the textarea uses. A failed save is now reported — [`useGroupDetails`](../../components/Group/useGroupDetails.ts) awaits `mutateAsync` and raises an error toast, replacing an `await mutate(...)` that resolved immediately and let the success toast fire regardless.

## Terms acceptance

`user.license_signed` records that a user accepted the liability disclaimer in [`CompliancePortal.tsx`](../../components/CompliancePortal.tsx). Those terms are written on behalf of Northeastern University and disclaim responsibility for rides, safety and data, so what this column means matters.

**It is trustworthy only for values written by `user.acceptTerms`.** Nothing used to write it on acceptance at all: the "I Agree" button fired a Mixpanel event and closed the dialog, and the flag was set instead as a hardcoded side effect of every `user.edit` call. The modal was also rendered on the onboarding page alone, while [`index.tsx`](../../pages/index.tsx)'s `getServerSideProps` redirects to `/profile/setup` only when `isOnboarded` is false — so an already-onboarded user with no consent recorded never saw the terms, and their next profile save silently set the flag to `true`.

Today: `user.acceptTerms` is the only writer, `user.edit` does not touch the column, and [`ComplianceGate`](../../components/ComplianceGate.tsx) is mounted once in `_app` so the terms appear on whichever page a user without consent lands on.

**Pre-existing rows were deliberately left as they are.** Forcing re-consent would put a blocking dialog in front of every active user, and the decision was that the disruption is not worth it. The consequence, which anyone relying on this column needs to know:

| Cohort                        | What `license_signed = true` means                                              |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Written by `user.acceptTerms` | The user clicked "I Agree" and the write succeeded                              |
| Rows predating that           | Either acceptance during onboarding **or** any profile save — indistinguishable |

There is no stored signal separating them, because the column carries no timestamp. Adding a timestamp and a terms version — which would also make re-consent possible when the terms are updated, something the terms text explicitly anticipates — needs new columns and is tracked separately. Do not treat a `true` predating that work as evidence for a specific user.

## One request per pair, and why it is not a constraint

`user.requests.create` treats "one `Request` row per pair of users" as an invariant. `extendPublicUser` picks a user's request with `.find()`, so a second row would make which conversation the UI shows arbitrary, and the reopen branch depends on there being exactly one row to reopen.

**Nothing in the database enforces it.** `Request` carries `@@index([fromUserId])` and `@@index([toUserId])` and no unique constraint, so the guarantee is procedural: the lookup and the write happen in one transaction, and `ConnectModal` disables Send while the mutation is in flight. SCRUM-349 is where that was decided; the reasoning is recorded here so the next reader does not have to rediscover it.

The invariant is over an **unordered** pair — `(A,B)` and `(B,A)` are the same relationship, which is why the duplicate guard is written as an `OR` over both directions — and MySQL cannot express that directly. Three options were weighed:

| Option                                        | Catches                                                           | Cost                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@@unique([fromUserId, toUserId])`            | the double-click case, where both calls write the same direction  | a migration and a PlanetScale deploy request; still misses simultaneous opposite directions |
| unique index on a generated `pair_key` column | everything                                                        | raw SQL in the migration, a column Prisma 4 cannot declare, plus the deploy request         |
| no constraint (**chosen**)                    | nothing structurally; the client guard removes the realistic path | none                                                                                        |

**Why no constraint was the answer, for now.** The transaction narrows the race but does not close it — MySQL will not lock rows a non-locking `SELECT` did not find, so two transactions can both see nothing and both insert. What actually removes the realistic path is the in-flight guard on the button, because the vector is a human double-click rather than concurrent clients. Against that, a directed unique index buys partial protection for a schema deploy, and the correct index buys full protection for raw SQL Prisma cannot express. Measured against production-derived `staging` on 2026-09-02: **477 requests, 0 duplicate pairs in either direction.** Paying a deploy request to enforce an invariant nothing has yet violated was not judged worth it.

**What would change the answer.** Any duplicate appearing in production, or a second client that can call `requests.create` without the modal. Before adding the index, re-run the duplicate audit — index creation fails outright if any exist, and de-duplicating means deciding what happens to the losing row's conversation and messages, which overlaps SCRUM-295.

```sql
SELECT COUNT(*) FROM (
  SELECT LEAST(fromUserId, toUserId) a, GREATEST(fromUserId, toUserId) b
  FROM request GROUP BY a, b HAVING COUNT(*) > 1
) duplicates;
```

## Indexes, and how to decide whether one is needed

Most `@@index` entries in `schema.prisma` are there because `relationMode = "prisma"` requires one on every relation scalar field, not because a query was measured against them. Only two exist purely for query performance:

| Index                            | Serves                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `location(coord_lat, coord_lng)` | the explore page's bounding box                            |
| `carpool_search(status, role)`   | the candidate filter's two most selective equality columns |

That ratio is deliberate. **A generated query that looks alarming is not evidence, and a missing index is not a diagnosis** — an index costs write throughput on every insert forever, so it needs a measurement behind it. The unread badge below is the worked example of reaching the opposite conclusion, and it is worth reading before adding an index here.

### The unread badge: the measurement, and why no index was added

[`getUnreadMessageCount`](../router/user/message.ts) compiles to nested `IN` subqueries over `message`, the fastest-growing table here, filtered on `isRead`, which carries no index. That description is accurate and it was filed as a performance concern. Measured, it is not one.

**What the plan does.** `EXPLAIN` against the staging branch on 2026-08-31 returned five rows, and the access types are the whole answer:

| Table                 | Access type   | Key                                              | Rows |
| --------------------- | ------------- | ------------------------------------------------ | ---- |
| `request` (`j1`)      | `index_merge` | `request_fromUserId_idx`, `request_toUserId_idx` | 2    |
| `conversation` (`j0`) | `eq_ref`      | `PRIMARY`                                        | 1    |
| `conversation` (`t1`) | `eq_ref`      | `PRIMARY`                                        | 1    |
| `message` (`t0`)      | `ref`         | `message_conversationId_idx`                     | 2    |
| `message`             | `eq_ref`      | `PRIMARY`                                        | 1    |

Nothing scans. The query is driven from the caller's **own** `request` rows and reaches `message` by primary key, so **its cost scales with how much mail the caller has, not with how large `message` has grown** — which is the opposite of what the nesting suggests, and the reason the growth argument does not apply.

**Why an index on `isRead` cannot help.** Two independent reasons, either sufficient:

1. The final access to `message` is already `eq_ref` on `PRIMARY` — the tightest access type MySQL has, one row. A secondary index cannot improve on a primary-key lookup.
2. `isRead` is a boolean. Two distinct values across the whole table is not selectivity, so the optimiser would decline the index even if the plan started there.

The composite `message(userId, isRead)` is worse than useless: the predicate is `userId != ?`, a negation, and no B-tree index range-scans a negation. The optimiser agrees: `message_userId_idx` appears in that row's `possible_keys` and is rejected in favour of `PRIMARY`. **That index exists only because `relationMode = "prisma"` requires one on every relation scalar field** — no query filters messages by author equality — so do not read its presence as evidence that indexing `userId` would help, and do not drop it either.

**Production, from PlanetScale Insights** (August 2026; Insights is readable where direct production queries return `403`):

|                         | rows read per call | time per call | p50     | p99      | tables | `EXPLAIN` rows |
| ----------------------- | ------------------ | ------------- | ------- | -------- | ------ | -------------- |
| with the role predicate | 32.5               | 3.47 ms       | 3.07 ms | 13.23 ms | 5      | 13             |
| without it (current)    | 10.9               | 3.18 ms       | 2.52 ms | 11.27 ms | 3      | 5              |

**The part that was real is already fixed.** Removing the counterpart-role predicate — done for a correctness reason, not a performance one — deleted both `DEPENDENT SUBQUERY` blocks from the plan. That matters more than the row counts: a dependent subquery is re-evaluated once per candidate outer row rather than once, so it multiplies where the rest of the plan adds. The four `IN` levels the ticket described are now two, the `user` and `carpool_search` joins are gone, and the SQL text sent per call fell from 1776 to 896 bytes.

The badge also runs about once per session rather than once per navigation: [`trpc.ts`](../../utils/trpc.ts) sets `refetchOnMount: false` and `refetchOnWindowFocus: false` globally, and the only other trigger is [`MessageContent`](../../components/Messages/MessageContent.tsx) invalidating it after marking a thread read.

**When to revisit, and with which index.** Re-run [`scripts/measure-unread-count.ts`](../../../scripts/measure-unread-count.ts), which prints the plan, the generated SQL and a verdict. Act if either holds:

- **anything scans** (`type: ALL` or `type: index` on `message`) — the plan changed, and then the column the scanning step filters on is the one to index;
- **rows examined exceeds ~1000 per call** while the plan is still fully indexed — a caller with enough history that the per-message primary-key lookup starts to add up.

In that second case the index to add is **`message(conversationId, isRead, userId)`**, not `isRead`. It covers the `t0` step and the final filter together, so the per-message primary-key lookup disappears entirely. It is not added today because at ~11 rows read per call it would cost write throughput on the busiest table in the schema to save nothing measurable.

## Changing the schema

After editing `schema.prisma`:

```bash
yarn db:schema     # prisma migrate dev && prisma generate
```

This creates a migration, applies it to your local MySQL container, and regenerates the client. Commit the new folder under `prisma/migrations/` alongside your schema change.

Avoid `prisma db push`. It applies changes without recording a migration, which leaves your local database out of sync with the committed migration history.

### What migrations are for here, and what they are not

Two mechanisms exist, and they do different jobs. Conflating them is what caused the missing-migration incident described below.

|                                              | Mechanism                                                                                       | Applies to                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Migration history** (`prisma/migrations/`) | `prisma migrate dev` locally; replayed in CI                                                    | local databases, CI databases, any newly provisioned database |
| **Shared schema promotion**                  | `prisma db push` to PlanetScale staging, then a **PlanetScale Deploy Request** staging → `main` | PlanetScale staging and `main`                                |

**Migration files are not applied to PlanetScale.** Nothing in the deploy pipeline runs `prisma migrate deploy` — the Amplify build runs [`amplify.yml`](../../../amplify.yml), whose build phase ends in `yarn run build:${BUILD_ENV}`, and PlanetScale Deploy Requests diff branch schemas without reading `prisma/migrations/` or `_prisma_migrations`. Migration history exists so that _anything built from the repository_ reproduces `schema.prisma`: a fresh clone, a CI database, a restore, a new branch.

`BUILD_ENV` is set per branch in the Amplify console, so the script it names cannot be read off the repository. It resolves to one of the three that exist, each of which runs `prisma generate && next build`:

```
build:main         = prisma generate && next build
build:development  = NODE_ENV=development prisma generate && next build
build:production   = NODE_ENV=production prisma generate && next build
```

**The `&&` matters.** With a single `&`, `prisma generate` is backgrounded and `next build` starts immediately, so the build can compile against a stale client and a failing generate never reaches the shell — a schema change that breaks generation then deploys green.

That separation is deliberate. Adopting `prisma migrate deploy` for shared environments would need every shared branch baselined with `prisma migrate resolve --applied` for all existing migrations, and would bypass the online-schema-change and safe-migration behaviour a Deploy Request provides. It is not planned. If it is ever revisited, it needs its own ticket and a baselining plan.

So a schema change is two commits' worth of work in two places:

1. **In the repository** — edit `schema.prisma`, run `yarn db:schema`, commit the new folder under `prisma/migrations/`.
2. **In PlanetScale** — push the schema to staging, then open a Deploy Request to promote staging → `main`. A GitHub Action comments a reminder on any PR that touches `schema.prisma`.

Doing only the second is how `tutorial_completed` came to exist in every shared database while no migration created it, which meant a database built from migration history alone failed every `User` query with `P2022` — no sign-in and no account creation.

### CI enforces step 1

The `schema` check ([`schema.yml`](../../../.github/workflows/schema.yml)) replays the committed migration history into a throwaway MySQL 8.0 service container and fails if the result differs from `schema.prisma`:

```bash
prisma validate
prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
```

`--exit-code` makes it a gate: `0` no difference, `1` error, `2` differences found. It fails closed, so an unreachable shadow database is a red check rather than a false green.

**If you run that command locally, point `--shadow-database-url` at a throwaway database.** `--from-migrations` _wipes_ whatever it is given, because that is where it replays the migrations. Never your development database.

The check proves migration history matches `schema.prisma`. It says nothing about what PlanetScale contains — that is still step 2, and still a human decision.

### A `package.json` script is part of the deploy surface

`amplify.yml`'s build phase ends in `yarn run build:${BUILD_ENV}` and `BUILD_ENV` is set in the Amplify console, so **any** `build:*` script is one console field away from running against a deployed environment. A `build:preview` entry that ran `echo "y" | prisma db push && … && prisma db seed` was deleted for exactly that reason.

`prisma db push` is the dangerous half: unlike `yarn seed`, which [`seedGuard.ts`](../../utils/seedGuard.ts) restricts to a localhost allowlist, **it has no host guard at all**. Pointed at a shared database it force-alters the schema successfully, and only a following seed would be refused — after the schema damage, not before it.

The deny rules for `build:preview` in [`.claude/settings.json`](../../../.claude/settings.json) are deliberately left in place: they cost nothing and would still fire if such a script were reintroduced.

## Location ownership

`Location` has no owning foreign key — `CarpoolSearch` points at it, not the
other way round — so nothing in the schema stops two searches from sharing a
row. The invariant is maintained in application code, and this is what it is:

> Every `Location` row is referenced by exactly one slot (`homeLocationId` **or**
> `companyLocationId`) of exactly one `CarpoolSearch`.

### Why it matters

`user.edit` used to "find or create" a Location by matching `street`, `city`,
`state` and `streetAddress`. The match ignored coordinates and there was no
branch that updated them, so:

- Whoever saved a given address string **first** set the coordinates for
  everyone who saved the same strings afterwards. Two people on the same long
  street, the same campus or the same apartment block collapsed onto one point.
  Distance is the dominant signal in `calculateScore`, so this was a matching
  bug, not a cosmetic one.
- A user could not correct their own coordinates. Re-picking a nearby Mapbox
  suggestion that parsed to the same strings appeared to save and moved
  nothing.
- Address changes orphaned rows, and nothing ever deleted them.

The strings being matched come from `parseMapboxFeature`, which drops
unit/suite detail, and can store a neighborhood where the city belongs — so collisions were realistic rather than theoretical.

### How it is maintained

[`resolveOwnedLocations`](./locationOwnership.ts) decides, per slot, whether to
rewrite the row already referenced or create a fresh one:

| Situation                                       | Result                                    |
| ----------------------------------------------- | ----------------------------------------- |
| No existing `CarpoolSearch`                     | Two new rows                              |
| Row referenced only by this slot                | Rewritten in place, same id               |
| Row referenced by another `CarpoolSearch`       | New row; the shared row is left untouched |
| Row referenced by _both_ of this search's slots | Home keeps it, company gets a new row     |

Rewriting in place is safe exactly when nobody else can be looking at the row,
which is what the reference check establishes. Every branch leaves the previous
row referenced by whoever else was using it, so **a profile save cannot orphan
a `Location`**.

### Rows orphaned before this rule existed

[`scripts/cleanup-orphan-locations.ts`](../../../scripts/cleanup-orphan-locations.ts)
removes them. It is a one-off for the backlog, not a recurring chore — a second
run should report zero.

```bash
npx ts-node scripts/cleanup-orphan-locations.ts              # report only
npx ts-node scripts/cleanup-orphan-locations.ts --apply      # delete
```

It is a dry run unless `--apply` is passed, re-checks every candidate
immediately before deleting it, and refuses to run when the candidate count
exceeds `--max` (default 500). It is deliberately **not** a `yarn` script: it
deletes production rows and should be reached for on purpose. Confirm
`DATABASE_URL` points where you intend first.

Staging reported zero orphans on 2026-08-31; production is unknown. Both the
record and the query that answers it without running the script live in
[`scripts/README.md`](../../../scripts/README.md#run-state-record) — update it
when you run this.

### Consequences to know about

- Two users at the same company now hold two rows rather than one. List queries
  such as `geoJsonUserList` therefore read more `location` rows than they used
  to. The correctness win is worth it, but it does cost row reads.
- These writes **are** transactional. `resolveOwnedLocations`
  is called with the transaction client inside `ctx.prisma.$transaction` in
  [`user.edit`](../router/user.ts), so a failure part-way through rolls back the
  `user` row, both `location` rows and the `CarpoolSearch` together. Before
  that they were four independent awaits and a mid-sequence failure left them
  inconsistent permanently — `relationMode = "prisma"` means the database
  rejects none of it and there is no reconciliation job.
- Nothing in the database enforces the invariant. Giving `Location` an owning
  `carpoolSearchId` would, at the cost of a schema change, a PlanetScale deploy
  request and a backfill.
