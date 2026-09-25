# Database layer

This directory holds the shared Prisma client. The schema, migrations and seed script live in [`prisma/`](../../../prisma).

- [`client.ts`](./client.ts) — the `PrismaClient` singleton. Cached on `global` outside production so hot reloading does not open a new pool per reload. Import this; never construct `new PrismaClient()` elsewhere.
- Application code reaches the database as `ctx.prisma`, built by the [tRPC context](../router/README.md).

## Data model

- **A user's carpool details are not on `User`.** `User` holds identity and profile only. Role, company, schedule, seats, status and group membership live on `CarpoolSearch`, which links to two `Location` rows (home and company). `user.me` merges the first `CarpoolSearch` onto the returned user, so **a flat-looking result does not mean flat storage**.
- **A user has at most one `CarpoolSearch`.** `@@unique([userId])` is a real MySQL index — unlike the relations, `relationMode = "prisma"` does not emulate it — so every read that takes "the" search by `userId` with no `orderBy` is well defined. `user.edit` creates the row on a first save, and retries a save the index refuses because a concurrent one won. Why one and not many: [the multi-search design](../../../docs/design/multi-carpool-search.md) (SCRUM-543, SCRUM-544).
- **A `Location` belongs to one slot of one `CarpoolSearch`** — never shared between users, nor between a single user's two slots. Anything writing locations must go through [`locationOwnership.ts`](./locationOwnership.ts). See [Location ownership](#location-ownership).
- **`relationMode = "prisma"`** — foreign keys are emulated by Prisma, not enforced by MySQL. Relation scalar fields need explicit `@@index` entries, and `onDelete` is carried out by Prisma.
- `Account`, `Session`, `User` and `VerificationToken` back NextAuth through the Prisma adapter. Changing them can break sign-in.

## Dates and times

Two `CarpoolSearch` columns store a moment with no zone, so the convention is the contract.

### Schedule times — `startTime` / `endTime` (`@db.Time(0)`)

A **UTC time of day** resolved against a **fixed anchor date**, so 9:00 AM in Boston stores as `14:00:00` in _either_ season. The anchor is the whole point: Boston is UTC-5 in winter and UTC-4 under daylight saving, so "9:00 AM in Boston" only names a UTC time once a date is named too.

Both directions go through [`scheduleTime.ts`](../../utils/scheduleTime.ts), which pins `SCHEDULE_ANCHOR_DATE`:

| Direction | Helper                 | Behaviour                                                          |
| --------- | ---------------------- | ------------------------------------------------------------------ |
| write     | `toStoredScheduleTime` | reads the **wall clock** off the picker, rebuilds it at the anchor |
| read      | `toPickerScheduleTime` | the stored instant as a Boston wall clock, for antd                |
| display   | `formatScheduleTime`   | the same conversion, formatted                                     |

Reading the wall clock rather than the instant is what makes writes date-independent — a student onboarding from California stores the schedule they typed, not one shifted three hours.

**That describes what is written now, not the whole column.** Four successive pickers each stored a Boston 9:00 AM differently, and the table holds the residue of all four — SCRUM-376 has the archaeology and the production counts. Two legacy classes matter, and they need opposite treatment:

> **Wall clock, five hours out.** Two of the four implementations wrote the typed digits straight through, so a 9-to-5 is stored `09:00`–`17:00` and renders as 4:00 AM to 12:00 PM. About 42% of the table. These _are_ identifiable — read as UTC they describe a shift starting before dawn and ending at noon, which no competing reading makes sensible. [`scheduleTimeIntegrity.ts`](./scheduleTimeIntegrity.ts) owns the classifier and [`repair-wallclock-schedule-times.ts`](../../../scripts/repair-wallclock-schedule-times.ts) the repair, scoped to co-ops that are running.

> **Converted under daylight saving, one hour early — and _not_ identifiable from the row.** `13:00` is a correct winter 8:00 AM and an incorrect summer 9:00 AM, and nothing records which. **Do not apply a blanket `+1 hour`** — it would corrupt every correctly stored winter row. Bucketing by `date_modified` is about 82% accurate for rows whose co-op is running and worse elsewhere, which SCRUM-376 records as too weak for an irreversible write. The remedy is asking affected users to re-save, as with coordinates below.

Note that a save **preserves** whatever was stored unless the user retypes the time: `toPickerScheduleTime` → `toStoredScheduleTime` is a deliberate no-op round trip. Legacy values therefore survive profile edits and whole co-op cycles, and `date_modified` records the last save rather than the last time the schedule was authored.

Render only through `formatScheduleTime`, which converts to `America/New_York`. Never format these columns inline. Boston is hardcoded deliberately: a co-op schedule has no meaning in the viewer's own zone.

**An overnight shift is legal and deliberately unvalidated.** These are two times of day, not a range, so 22:00–06:00 is correct. [`minutesApart`](../../utils/recommendation.ts) measures the gap the short way round the clock (`min(d, 1440 - d)`), so overnight pairs score properly.

### Co-op dates — `startDate` / `endDate` (`@db.Date`)

A calendar day taken from the **UTC** date of whatever `Date` Prisma is handed. Build them with [`lastDayOfMonthUTC`](../../utils/dateUtils.ts), never `new Date(year, month, 0)` — the local-time form stores the previous day for anyone at a positive UTC offset.

**Never write a picker value straight to the form.** Both controls go through a handler that calls `lastDayOfMonthUTC`. Writing `date.toDate()` directly gives local midnight on the _first_ of the month, which breaks two rules at once: the UTC one, and the convention that these columns hold the **last** day of the chosen month. The consequence is silent — `dateOverlapFilter` compares a first-of-month value against a last-of-month one and drops exact matches.

**The range must run forwards.** A reversed range used to be stored as submitted and then fail silently at match time, because the full-overlap branch asks for `startDate <= theirs AND endDate >= theirs`, which nothing can satisfy once crossed. `user.edit` and [`onboardSchema`](../../utils/profile/zodSchema.ts) both refuse it via [`reversedCoopRangeFields`](../../utils/dateUtils.ts) — **except for a VIEWER**, whose date pickers are disabled while every save re-sends the stored dates, so refusing theirs would block every save they make (SCRUM-551). The check returns when they switch role and the pickers enable.

**Equality is allowed**, and has to be: both pickers are month-granularity and store the last day, so a one-month co-op is the same date twice.

**The year must be plausible.** Production holds 22 searches dated like 1901→1908 or 2069→2073 — they run forwards, so the ordering rule never saw them (SCRUM-550). [`coopYearBounds`](../../utils/dateUtils.ts) allows 2022, the year this repository began, through ten years past the current one. The floor is fixed so a real co-op never ages into a rejection; the ceiling moves so it never expires. `user.edit` and `onboardSchema` both refuse a year outside it, **except for a VIEWER**, whose pickers are disabled while every save re-sends the stored dates — refusing theirs would reject every save they make. The stored rows are not rewritten: adding a century still lands before the platform existed, so the profile page asks the user instead, through [`planCoopRangeNotice`](../../utils/profile/coopRangeNotice.ts).

## Coordinates

`location.coord_lat` / `coord_lng` are plain `Float` columns, so the database accepts anything — and out-of-range values fail _silently_ downstream rather than loudly, since `locationWithin` adds a degree delta and `milesBetween` feeds the value through `Math.cos`. A nonsense row is simply unmatchable.

Both are therefore bounded to WGS 84 at the write boundary, using [`utils/coordinates.ts`](../../utils/coordinates.ts).

**`(0, 0)` needs its own rule.** It is inside the valid range but it is the sentinel [`useAddressSelection`](../../utils/useAddressSelection.ts) starts at and resets to, so it means "no address picked yet". `user.edit` refuses it for every role except `VIEWER`, which has no `Location` at all. Only the exact pair is refused — longitude 0 is Greenwich and latitude 0 is the equator, and a row at one but not the other is a real place.

The forms check the **address hooks**, not the form fields: `ControlledAddressCombobox` only writes back when a suggestion is chosen and coordinates never enter the form, so leftover address text can sit next to `(0, 0)`.

Legacy rows are reported by [`check-profile-coordinates.ts`](../../../scripts/check-profile-coordinates.ts), which is read-only **by design** — a lost coordinate cannot be re-derived, and only the student knows which way round their co-op runs. The remedy is asking affected users to re-save.

## What Prisma logs

`client.ts` uses **event-based** logging (`{ emit: "event", level }`) with its own handlers, not plain level strings. Level strings are Prisma's _stdout_ mode, where the client formats and prints its own message and nothing can intervene — a second route out of the request under no policy, while [`[trpc].ts`](../../pages/api/trpc/%5Btrpc%5D.ts) deliberately redacts the tRPC error payload in production.

[`prismaLog.ts`](prismaLog.ts) holds the policy: in production a line is `{ target, message }` with the message reduced to the failure reason; outside production the raw message passes through so the code frame survives.

Measured against Prisma 4.16.2 rather than assumed:

- **Argument values are not logged** in either mode. The common suspicion — that addresses and emails leak here — is wrong.
- What _is_ logged is the rendered invocation, plus an absolute path and an excerpt of the app's own source where Prisma can resolve it, then the reason.
- Production gets the **frameless** spelling, because Prisma cannot read original sources out of bundled `next build` output. That is why the invocation line has two spellings (`invocation in` and `invocation:`) and why `PREAMBLE` matches both — matching only the frame-bearing one passes every test written from a local payload and still leaks in production.

`target` is kept in every environment (`user.findUnique`, `quaint::pooled`). It is the one field that makes a line actionable and holds no argument, path or source.

> **`query` logging is the channel that would log parameters, and it is not enabled. Do not enable it in a deployed environment.**

## Text lengths

MySQL runs in strict mode, so a value wider than its column **throws** rather than truncating. Prisma raises `P2000` and tRPC turns it into a 500 — a server error for what is really validation, after the UI already accepted the text. Every Zod input writing free text to a bounded column therefore carries a matching `.max()`.

An unannotated `String` is `VARCHAR(191)`, which is why so many limits are 191.

| Column                                                  | Width          | Bounded by                                           |
| ------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| `message.content`                                       | `VARCHAR(255)` | `messages.sendMessage`, `requests.create`            |
| `user.bio`, `.preferred_name`, `.pronouns`              | `VARCHAR(191)` | `user.edit`, `onboardSchema`                         |
| `carpool_search.company_name`                           | `VARCHAR(191)` | `user.edit`, `onboardSchema`                         |
| `carpool_search.group_notes`                            | `VARCHAR(90)`  | `groups.updatePreferences`, the `GroupPage` textarea |
| `carpool_search.group_music_preference`                 | `VARCHAR(40)`  | `groups.updatePreferences`                           |
| `carpool_search.group_conversation_style`               | `VARCHAR(40)`  | `groups.updatePreferences`                           |
| `request.message`                                       | `VARCHAR(255)` | never written; `requests.create` stores `""`         |
| `report.message`                                        | `VARCHAR(500)` | `reports.create`, the `ReportDialog` textarea        |
| `location.street`, `.street_address`, `.city`, `.state` | `VARCHAR(191)` | parsed from a Mapbox feature, not typed              |

The values live in [`textLimits.ts`](../../utils/textLimits.ts) so the form, the tRPC input and the column cannot drift. **Reference the constants; never write the number inline** — including where a value is only forwarded and not stored, such as the SES `messagePreview`, which is a real case of drift this module exists to prevent.

### The two group-message columns are gone

Group ride preferences used to be one JSON blob written to `group.message` and mirrored into `carpool_search.group_message`. They are three real columns on the driver's own `CarpoolSearch`, and both legacy columns were dropped in SCRUM-287 — `20260916120000_drop_legacy_group_message_columns`.

The sequence is worth keeping, because it is the pattern any column retirement here follows:

1. **Expand.** Add the new columns, write them, and leave the old one readable. [`resolveGroupDetails`](../../components/Group/groupDetails.ts) treated all three new columns being null as "never saved" and fell back to parsing the old blob, so a row that had not been backfilled still rendered correctly.
2. **Backfill.** [`backfill-group-preferences.ts`](../../../scripts/README.md#retiring-a-script) moved the history across — 3 rows on staging, 11 on production — and a dry run confirmed nothing was left.
3. **Contract.** Only then drop the columns and the fallback, because dropping one a row still depends on loses that row's data with no route back but a restore.

Doing 3 before 2 was the risk the whole ticket existed to avoid: every legacy value turned out to be plain text rather than the `GROUP_DETAILS_V1:` encoding, so `parseGroupDetails` mapped all fourteen to real notes a driver could see.

One asymmetry left behind by step 3: `resolveGroupDetails` no longer needs to tell null from `""`, since there is nothing to fall back to. `groups.updatePreferences` still writes all three fields together anyway, which is what keeps a cleared field cleared.

## Terms acceptance

`user.license_signed` records acceptance of the liability disclaimer in [`CompliancePortal.tsx`](../../components/CompliancePortal.tsx), written on behalf of Northeastern, so what the column means matters.

`user.acceptTerms` is now the only writer, `user.edit` does not touch it, and [`ComplianceGate`](../../components/ComplianceGate.tsx) mounts once in `_app` so the terms appear wherever a user without consent lands.

> **The column is trustworthy only for rows written by `user.acceptTerms`.** It previously got set as a side effect of _any_ profile save, and the modal only rendered during onboarding — so an already-onboarded user could have `true` without ever seeing the terms. Pre-existing rows were deliberately left alone rather than forcing re-consent.

### The two cohorts are now distinguishable

`license_signed_at` and `license_version` record **when** the acceptance happened and **which wording** was accepted. `user.acceptTerms` writes all three columns together and is still their only writer.

| `license_signed` | `license_signed_at` | `license_version` | What the row means                                                       |
| ---------------- | ------------------- | ----------------- | ------------------------------------------------------------------------ |
| `false`          | null                | null              | Never accepted. The gate shows the dialog.                               |
| `true`           | a timestamp         | a date string     | A real acceptance of known wording, recorded by `user.acceptTerms`.      |
| `true`           | **null**            | **null**          | **The legacy cohort.** Accepted, or merely saved a profile — unknowable. |

**Null is the record, not a gap.** There was no timestamp to recover and no version to infer, so the migration backfills nothing; the nullness _is_ what identifies the untrusted cohort, which is what makes a targeted re-consent possible for the first time. As of the migration that is every `license_signed = true` row on production — 3,341 of 4,486 users.

**Do not treat a null-version `true` as evidence for a specific user.** That has not changed; what changed is that you can now tell which rows those are.

The boolean was kept rather than replaced because it is the only acceptance record the legacy cohort has, so the usual expand/backfill/contract cycle has nothing to backfill from and no contract phase to reach.

### Re-consent is a policy, not a consequence of a version bump

[`src/utils/termsAcceptance.ts`](../../utils/termsAcceptance.ts) is the canonical home for `CURRENT_TERMS_VERSION`, the gate condition, and a separate `TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE` flag that ships **off**. Bumping the version records what new acceptances agreed to; it does not re-prompt anybody. Turning the flag on re-prompts every stale and every legacy row, which is a university and legal decision rather than an engineering one — the terms themselves currently say continued use constitutes acknowledgment of updates.

The version string names the **text**, not the release: it is the date the prose in `CompliancePortal.tsx` last changed. A test fingerprints that prose and fails if it moves without the version moving with it.

## One request per pair, and why it is not a constraint

`requests.create` treats "one `Request` row per pair of users" as an invariant: `extendPublicUser` picks a request with `.find()`, so a second row makes the displayed conversation arbitrary, and the reopen branch assumes exactly one row.

**Nothing in the database enforces it.** The guarantee is procedural — the lookup and the write happen in one transaction, and `ConnectModal` disables Send while the mutation is in flight.

The invariant is over an **unordered** pair, which is why the duplicate guard is an `OR` over both directions, and which MySQL cannot express directly. `@@unique([fromUserId, toUserId])` would catch only the same-direction double-click; catching everything needs a generated `pair_key` column that Prisma 4 cannot declare. Both cost a migration and a PlanetScale deploy request.

The transaction narrows the race without closing it — MySQL will not lock rows a non-locking `SELECT` did not find, so two transactions can both see nothing and both insert. What removes the _realistic_ path is the in-flight button guard, because the vector is a human double-click. Measured against production-derived staging: 477 requests, **0 duplicate pairs**.

**What would change the answer:** any duplicate in production, or a second client able to call `requests.create` without the modal. Re-run the audit first — index creation fails outright if duplicates exist, and de-duplicating means deciding what happens to the losing row's conversation and messages.

```sql
SELECT COUNT(*) FROM (
  SELECT LEAST(fromUserId, toUserId) a, GREATEST(fromUserId, toUserId) b
  FROM request GROUP BY a, b HAVING COUNT(*) > 1
) duplicates;
```

## Indexes

Most `@@index` entries exist because `relationMode = "prisma"` requires one on every relation scalar field, not because a query was measured. Only two serve query performance:

| Index                            | Serves                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `location(coord_lat, coord_lng)` | the explore page's bounding box                            |
| `carpool_search(status, role)`   | the candidate filter's two most selective equality columns |

That ratio is deliberate. **An alarming-looking generated query is not evidence, and a missing index is not a diagnosis** — an index costs write throughput on every insert forever, so it needs a measurement behind it.

The worked example is `getUnreadMessageCount`, which compiles to nested `IN` subqueries over the fastest-growing table and looks like an obvious index candidate. It is not one: the plan is driven from the caller's **own** `request` rows and reaches `message` by primary key, so **its cost scales with how much mail the caller has, not with how large `message` has grown**. An index on `isRead` cannot help either — the final access is already `eq_ref` on `PRIMARY`, and a boolean has no selectivity. `message_userId_idx` exists only because `relationMode` requires it; no query filters messages by author, so do not read its presence as evidence — and do not drop it.

**When to revisit.** Re-run [`measure-unread-count.ts`](../../../scripts/measure-unread-count.ts), which prints the plan, the SQL and a verdict. Act if **anything scans** (`type: ALL` or `index` on `message`), or if rows examined exceeds ~1000 per call while the plan is still fully indexed. The index to add then is **`message(conversationId, isRead, userId)`** — not `isRead`.

## Changing the schema

```bash
yarn db:schema     # prisma migrate dev && prisma generate
```

Commit the new folder under `prisma/migrations/` with your schema change. **Avoid `prisma db push` locally** — it applies changes without recording a migration.

**A schema change is two separate things in two places:**

|                         | Mechanism                                                                               | Applies to                             |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| Migration history       | `prisma migrate dev` locally; replayed in CI                                            | local and CI databases, new provisions |
| Shared schema promotion | `prisma db push` to PlanetScale **staging**, then a **Deploy Request** staging → `main` | PlanetScale staging and `main`         |

> **Migration files are never applied to PlanetScale.** Nothing in the deploy pipeline runs `prisma migrate deploy`, and Deploy Requests diff branch schemas without reading `prisma/migrations/`. Migration history exists so anything built _from the repository_ reproduces `schema.prisma`.

Doing only the PlanetScale half is how `tutorial_completed` came to exist in every shared database with no migration creating it — so a database built from history alone failed every `User` query with `P2022`: no sign-in, no account creation.

Adopting `prisma migrate deploy` for shared environments would need every branch baselined with `prisma migrate resolve --applied`, and would bypass the online-schema-change behaviour a Deploy Request provides. Not planned; needs its own ticket and a baselining plan.

### CI enforces the repository half

The `schema` check replays committed migrations into a throwaway MySQL container and fails if the result differs from `schema.prisma`. It fails closed, so an unreachable shadow database is a red check rather than a false green.

> **If you run `prisma migrate diff --from-migrations` locally, point `--shadow-database-url` at a throwaway database.** It **wipes** whatever it is given. Never your development database.

The check proves history matches `schema.prisma`. It says nothing about what PlanetScale contains — that remains a human decision.

### A `package.json` script is part of the deploy surface

`amplify.yml` ends in `yarn run build:${BUILD_ENV}` with `BUILD_ENV` set in the Amplify console, so **any** `build:*` script is one console field away from running against a deployed environment. A `build:preview` entry that ran `prisma db push` and re-seeded was deleted for that reason.

`prisma db push` is the dangerous half: unlike `yarn seed`, which [`seedGuard.ts`](../../utils/seedGuard.ts) restricts to a localhost allowlist, **it has no host guard at all**. Pointed at a shared database it force-alters the schema successfully.

## Integration tests against a real database

`yarn test` runs entirely on mocks, which cannot catch a malformed `where`, a wrong relation traversal, an emulated referential action, or a transaction that does not roll back. `yarn test:db` is the second suite and runs against a real MySQL.

Create a database it is allowed to destroy, then name it in `.env` as its **own** variable alongside `DATABASE_URL`:

```bash
docker exec mysql-on-docker mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "CREATE DATABASE IF NOT EXISTS nucarpool_test"
# .env
TEST_DATABASE_URL=mysql://root:<password>@127.0.0.1:3306/nucarpool_test
```

`globalSetup` approves the target, claims the database, applies migration history and empties it — in that order, and the order is load-bearing: `prisma migrate deploy` raises P3005 on a schema that is not empty and carries no `_prisma_migrations`, so the claim marker is written _after_ the deploy rather than before it.

You do not have to run this locally to have it run: the `test-db` CI job brings up its own MySQL 8.0 and runs the suite on every pull request. See [the testing docs](../../../docs/testing.md#the-database-suite) for the guards, the truncation contract and what the suite does and does not currently cover.

Two points specific to this layer:

- **Build fixtures in `beforeEach` or the test body, never `beforeAll`** — truncation runs before every test.
- Truncation discovers tables through `information_schema`, not Prisma's model list. That is load-bearing: `_Favorites` is an implicit join table Prisma exposes no delegate for, so a model-driven reset leaves rows standing.

## Location ownership

`Location` has no owning foreign key — `CarpoolSearch` points at it — so nothing in the schema stops two searches sharing a row. The invariant is maintained in application code:

> Every `Location` row is referenced by exactly one slot (`homeLocationId` **or** `companyLocationId`) of exactly one `CarpoolSearch`.

This matters because `user.edit` used to find-or-create a `Location` by matching address strings, ignoring coordinates. Whoever saved an address string **first** set the coordinates for everyone who saved the same strings afterwards, collapsing two people on one street onto one point — and distance is the dominant signal in `calculateScore`, so it was a matching bug rather than a cosmetic one. A user also could not correct their own coordinates.

[`resolveOwnedLocations`](./locationOwnership.ts) decides per slot whether to rewrite the referenced row or create a fresh one:

| Situation                                       | Result                                 |
| ----------------------------------------------- | -------------------------------------- |
| No existing `CarpoolSearch`                     | Two new rows                           |
| Row referenced only by this slot                | Rewritten in place, same id            |
| Row referenced by another `CarpoolSearch`       | New row; the shared row left untouched |
| Row referenced by _both_ of this search's slots | Home keeps it, company gets a new row  |

Rewriting in place is safe exactly when nobody else can be looking at the row, which is what the reference check establishes. **A profile save cannot orphan a `Location`.**

- **These writes are transactional.** `resolveOwnedLocations` is called with the transaction client inside `ctx.prisma.$transaction` in [`user.edit`](../router/user.ts), so a part-way failure rolls back the user row, both locations and the `CarpoolSearch` together. `relationMode = "prisma"` means nothing would reject an inconsistent result and there is no reconciliation job.
- Two users at the same company now hold two rows rather than one, so list queries read more `location` rows. Accepted for correctness.
- Nothing in the database enforces the invariant. Giving `Location` an owning `carpoolSearchId` would, at the cost of a migration, a deploy request and a backfill.

Rows orphaned before the rule existed are removed by [`cleanup-orphan-locations.ts`](../../../scripts/cleanup-orphan-locations.ts) — a one-off, dry-run by default. See [`scripts/README.md`](../../../scripts/README.md).

## Conversation ownership

The `Request` ↔ `Conversation` link is stored **twice**, and the schema keeps neither side honest:

- `Request.conversationId` — the declared relation, nullable, `onDelete: Cascade`. `Request` holds the key, so it is the **child**.
- `Conversation.requestId` — `@unique`, with **no relation declared at all**. A bare string nothing validates.

**`Conversation.requestId` is the authoritative side**, and what [`findOrCreateConversation`](./conversationLink.ts) keys on: reading `Request.conversationId` answers whether _that row_ knows about a conversation, not whether one exists.

> Every `Conversation` is referenced by a `Request` that still exists, and no `Request` is deleted without its `Conversation`.

**The declared cascade runs the wrong way for deletion.** `onDelete: Cascade` on `Request.conversation` means deleting a _Conversation_ deletes its _Requests_ — the reverse of what is needed. Nothing ran Request → Conversation, so every decline and withdrawal used to leave a conversation and all its messages behind with `requestId` dangling.

Those rows are **unreachable, not merely untidy**, and the two links are read by different paths — so "no request owns this row" and "nothing can read this row" are different questions. An orphan is therefore defined as a conversation no live request reaches by **either** link, which is the same definition the cleanup script re-checks immediately before each delete.

### How it is maintained

`requests.delete` deletes the request, then its messages, then the conversation, **in one transaction and in that order**. The request has to go first: the other order trips the declared Conversation → Request cascade, which removes the request as a side effect and makes the explicit delete throw.

Messages are deleted **explicitly** rather than relying on the emulated cascade. Prisma does emulate it, so this is belt and braces — but the failure mode would be message rows pointing at a missing conversation, and no test here could catch it, because the mocked suite would only assert that the mock cascades.

> The delete filter comes from `conversationsToDeleteWith`, which **never emits `{ id: undefined }`**. Prisma reads a key present with an `undefined` value as _no filter on that key_, so including it unconditionally would turn a one-row delete into a whole-table delete.

**Declining destroys the thread, deliberately.** That does not conflict with `requests.create`'s reopen branch, which acts on an `ACCEPTED` row that still exists; this path has already removed the row.

### The existing orphan backlog is retained by decision

Production holds 620 orphaned conversations containing 1,258 messages, all confirmed unreachable by both links. **The decision was to keep them**, revisited only if they cause a problem. Consequences, so nobody re-derives them:

- The admin dashboard's conversation total and messages-per-conversation average read permanently high. **Accepted, not a defect.**
- 1,258 messages of attributable personal data remain with no read, correction or erasure path. Related to there being no account-deletion feature.
- **Nothing produces new ones.** `requests.delete` now removes the conversation with the request, so [`cleanup-orphan-conversations.ts`](../../../scripts/cleanup-orphan-conversations.ts) reporting **above** 620 means that fix regressed. The script is a monitoring instrument, not a pending action.

Reversing the decision needs a new decision, not an `--apply` run on the strength of this paragraph. The script destroys message content, so its dry run prints the message count per conversation — that is the number to read first.

### Also worth knowing

- **The schema was left alone.** Correcting the relation direction would put the invariant in the schema at the cost of a migration and a deploy request — and under `relationMode = "prisma"` MySQL still would not hold it. If it is ever corrected, `conversationsToDeleteWith` and the cleanup script become redundant together.
- **`Conversation.request` is a list** (`Request[]`), because the relation is declared from the nullable child side. Nothing stops two requests pointing at one conversation.
- **A null `Request.conversationId` is legitimate**, not corruption — every request predating the conversation model has one. They are repaired lazily by `findOrCreateConversation` on the first write that needs a conversation, never backfilled.

## Blocks

A `Block` row is one user's choice, but its effect is symmetric: every check in [`blocks.ts`](./blocks.ts) matches a row in either direction (SCRUM-554).

- **Hidden, never deleted.** Requests, favourites and conversations between a blocked pair are filtered where they are read. Unblocking restores them exactly, and nothing a report might later need is lost.
- **Where it is enforced.** Discovery (`candidateExclusions`, shared by recommendations and the map), `favorites.me` and adding a favourite, `requests.me` and `requests.create`, both group join paths, `messages.conversation`, `sendMessage` and the unread count, all three notification emails, and Pusher conversation-channel auth.
- **Where it deliberately is not.** `requests.delete`, removing a favourite, and leaving or dissolving a group. A user must always be able to get out.
- **A blocked pair never shares a group.** `user.blocks.block` refuses someone in the caller's group ("Leave the group first"), and `groups.edit` checks a joining rider against every member, not only the driver. The two checks are separate reads, so a block and a join racing each other can still both succeed. There is no constraint behind it, for the same reason as [one request per pair](#one-request-per-pair-and-why-it-is-not-a-constraint).

## Reports

A report is filed through `user.reports.create` and read by admins through `user.admin.getReports` (SCRUM-555). Nothing about it is shown to the reported user.

- **A report made from a conversation keeps its own copy.** The server writes the last 50 messages into `conversation_snapshot`, because either party can delete the request, and `requests.delete` takes the conversation and every message with it. `request_id` is a plain id for the same reason. The copy is built on the server, never accepted from the client.
- **One OPEN report per reporter and person.** It is a read before the insert, not a constraint, because it depends on `status`. Two simultaneous submissions can both pass.
- **"Also block" goes through the same `applyBlock` as the Block button.** The report and the block commit together. A refusal for someone in the reporter's group is the one exception: the report still saves and the refusal is returned as a note.
- **The snapshot is the one place admins read message text.** `getReports` reads the copy on the report, never the `message` table.

## Account deletion

**There is no delete-my-account feature, and that is a decision rather than an omission.** Nothing needs fixing to allow one, and the schema should not be changed to make one possible without revisiting the decision. This section exists so the cascade question is not rediscovered and assumed to be a bug.

`User` has ten incoming relations; five cascade and five restrict:

| Relation                                             | On user delete      |
| ---------------------------------------------------- | ------------------- |
| `Account.user`, `Session.user`, `CarpoolSearch.user` | `Cascade`           |
| `Block.blocker` / `Block.blocked`                    | `Cascade`           |
| `Request.fromUser` / `Request.toUser`                | emulated `Restrict` |
| `Message.User`                                       | emulated `Restrict` |
| `Report.reporter` / `Report.reportedUser`            | emulated `Restrict` |

A block means nothing once either user is gone, so it cascades. A report is evidence, and restricts for the same reason messages do. See the comments on both models in `schema.prisma`.

`relationMode = "prisma"` makes `Restrict` the default when no `onDelete` is declared, enforced in application code. So deleting a user who has ever sent a request or message — every real user — fails. **Under this decision that is correct**, and the absent `onDelete` is what stops an accidental delete taking message history with it.

- **The favourites relation is not part of this question.** `User.favorites` is an implicit many-to-many, and Prisma **refuses to compile** a referential action on one. Prisma owns that join table and clears it itself.
- **The seed's delete order is load-bearing.** `deleteAllData` removes rows child-first and finishes with `user`, which is what lets it succeed against emulated `Restrict`. Reordering it or collapsing it into fewer calls breaks seeding.
- **The refusal is enforced, not just written down.** [`authAdapter.ts`](../authAdapter.ts) overrides `deleteUser` to throw. `PrismaAdapter` supplies a working-looking one, and inheriting it left the auth route carrying a primitive that could not work.

**If the decision is reversed**, the cascade is the easy part. The hard part is the product question: **what happens to messages a counterpart also participated in**, since deleting one party's messages edits the other party's history. Decide that first, then set the referential actions (migration **and** deploy request), remove the `deleteUser` refusal, add the procedure transactionally, delete the S3 object too — `profile-pictures/{env}/{userId}` is keyed on an id that would no longer resolve — and consider group membership.

Honouring a one-off erasure request is a **different question** from declining the feature: this app stores home coordinates, company addresses and private messages for real students, and such a request would currently be served by hand with no script and no recorded procedure. That gap is tracked separately.

## Profile picture presence

`User.profilePictureUpdatedAt` answers "does this user have a picture?" without leaving the datacenter, and it is the **only** answer: `getPresignedDownloadUrl` signs a URL when the column is set and returns `{ url: null }` when it is null. Signing is a local HMAC, so rendering an avatar makes no S3 request for anyone. It used to cost a `HeadObject` round trip purely to tell "no picture" from "picture exists" — and a cold explore view paid up to 50 of them.

The client PUTs straight to S3, so nothing in that flow reaches the server; `user.recordProfilePictureUpload` exists for that reason and is called **after** the PUT returns `ok`. Writing the column when the URL is _issued_ would be simpler and wrong — signing is not evidence of an upload, and S3 rejects a body disagreeing with the signature, so the column would claim pictures that do not exist. The converse now matters as much: a PUT that succeeds without being recorded leaves an object the app never shows. The profile save reports that as a failed picture upload and keeps the file for a retry, which records it.

Null reads as "no picture" only because the gap was closed first. SCRUM-276 added the column **expand-only**: every row predating it was null whether or not an object existed, so for a while a null row still fell back to `HeadObject`. A one-off backfill then recorded each existing picture's S3 `LastModified` — not `now()`, so the column keeps meaning "when the picture last changed" — and SCRUM-366 removed the fallback once a dry run reported nothing left to record on both staging and production. The figures are in the [scripts run-state record](../../../scripts/README.md#run-state-record).

- **There is no delete-picture path in the app** — only replacement, which writes a fresh timestamp. If removal is ever added it must clear the column, or the download path will sign URLs for a deleted object.
- **The column is not exposed to clients.** It is read server-side inside `getPresignedDownloadUrl` and nowhere else.
- **`NEXT_PUBLIC_ENV` namespaces the S3 keys**, which is why changing it orphans uploads.
