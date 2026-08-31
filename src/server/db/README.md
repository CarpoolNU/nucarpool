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

Two columns on `CarpoolSearch` store a moment without a zone, so the convention matters (SCRUM-239).

**Schedule times — `startTime` / `endTime` (`DateTime? @db.Time(0)`)**

A time of day in **UTC**, with no date attached. `user.edit` parses the ISO string the client sends and Prisma writes the UTC time of day out of it, so a student picking 9:00 AM in Boston is stored as `14:00:00`.

Render with [`formatScheduleTime`](../../utils/scheduleTime.ts), which converts to `America/New_York`. Every schedule time in the UI goes through that one helper — do not format these columns inline. `UserCard` and `ConnectModal` each used to carry a copy that reinterpreted the value as UTC when the Boston hour fell between 01:00 and 04:59, which was a guess about rows predating the standardisation in SCRUM-147 / SCRUM-157 and mislabelled genuine early shifts.

Boston is hardcoded because the product is Northeastern co-op students; a schedule has no meaning in the viewer's own zone.

**An overnight shift is legal, and deliberately unvalidated (SCRUM-302).** These are two times of day, not a range, so nothing requires the second to come after the first: a night shift starting at 22:00 and finishing at 06:00 stores exactly that, and it is correct. [`minutesApart`](../../utils/recommendation.ts) measures the gap between two people's times the short way round the clock — `min(d, 1440 - d)` — so an overnight pair is scored properly rather than merely tolerated, and nothing in the scorer or in [`buildCandidateWhere`](./candidateSearch.ts) compares a user's own start against their own end. Contrast the co-op columns below, which **are** a range and are checked.

**Co-op dates — `startDate` / `endDate` (`DateTime? @db.Date`)**

A calendar day, taken by Prisma from the **UTC** date of whatever `Date` it is handed. Build these with [`lastDayOfMonthUTC`](../../utils/dateUtils.ts) rather than `new Date(year, month, 0)`: the local-time form stored the previous day for anyone at a positive UTC offset, because local midnight is the day before in UTC.

**The range has to run forwards (SCRUM-302).** A reversed one was stored as submitted and then failed silently at match time: `dateOverlapFilter`'s full-overlap branch asks for `startDate <= theirs AND endDate >= theirs`, which no candidate can satisfy once the two are crossed, so the user disappeared from every full-overlap search with nothing to say why, and the partial-overlap negation behaved arbitrarily. `user.edit` and [`onboardSchema`](../../utils/profile/zodSchema.ts) both refuse `endDate < startDate` now, through the shared [`isReversedCoopRange`](../../utils/dateUtils.ts).

**Equality is allowed**, and has to be: both pickers are month-granularity and `handleMonthChange` stores the _last day_ of the month chosen, so a one-month co-op is the same date twice.

## Coordinates

`location.coord_lat` and `coord_lng` are plain `Float` columns, so the database accepts any number at all — and out-of-range values do not fail downstream either, they merely stop meaning anything. `locationWithin` adds a degree delta to whatever centre it is given and `milesBetween` feeds the value through `Math.cos`, so a nonsense row is silently unmatchable rather than loud, and it is scanned for nothing by the `location_coord_lat_coord_lng_idx` bounding box added in SCRUM-245.

Both are therefore bounded to WGS 84 at the boundary that writes them (SCRUM-302). The definitions live in [`utils/coordinates.ts`](../../utils/coordinates.ts), shared with `getDirections`, which has range-checked its own input since SCRUM-244.

**`(0, 0)` needs a separate rule.** It is inside the valid range, but it is the sentinel [`useAddressSelection`](../../utils/useAddressSelection.ts) starts at and resets to when the address input is cleared, so it means "no address picked yet" rather than a point in the Gulf of Guinea ~4000 miles from Boston. `user.edit` refuses it for every role except `VIEWER` — a VIEWER has no `Location` at all, and `user.me` already reports `(0, 0)` for a row without one. Only the exact pair is refused: longitude 0 is Greenwich and latitude 0 is the equator, and a row at one and not the other is a real place.

The forms check the same thing before saving, against the address hooks rather than the form fields. That distinction matters: `startAddress` and `companyAddress` hold address _text_, `ControlledAddressCombobox` writes back to the form only when a suggestion is chosen, and the coordinates never enter the form at all — so text left over from a previous save can sit next to `(0, 0)`.

### Rows that predate the check

[`scripts/check-profile-coordinates.ts`](../../../scripts/check-profile-coordinates.ts) reports them, along with reversed co-op ranges and searches pointing at a `Location` that no longer exists.

```bash
npx ts-node scripts/check-profile-coordinates.ts
```

It is read-only and has no `--apply`, deliberately: a lost coordinate cannot be re-derived without re-geocoding an address string that may itself be empty, and only the student knows which way round their own co-op runs. There is no correct value to write, so the remedy is to ask the affected users to re-save their profile — which the boundary now validates. A `VIEWER` at `(0, 0)` is not reported, since that is expected.

## Text lengths

MySQL runs in strict mode, so a value wider than its column makes the write **throw**, not truncate. Prisma surfaces that as `P2000` and tRPC turns it into an `INTERNAL_SERVER_ERROR` — a 500 for what is really a validation problem, raised after the UI has already accepted the text. Every Zod input that writes free text to a bounded column therefore carries a `.max()` matching that column (SCRUM-231).

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

Group ride preferences used to be one `GROUP_DETAILS_V1:{…json…}` blob, written into `group.message` _and_ mirrored into `carpool_search.group_message`. SCRUM-253 replaced that with the three real columns above, owned by the driver's own `CarpoolSearch`.

**Neither column needs widening, and neither should be.** An earlier version of this section said `group.message` could overflow and that restoring `@db.Text` was the fix — a migration and a PlanetScale deploy request for a column that is now written empty. That advice pointed the opposite way to the plan of record:

- **`group.message`** — [`groups.create`](../router/user/groups.ts) writes `""` and nothing reads it. There is no path that puts content in it, so its width is irrelevant.
- **`carpool_search.group_message`** — read-only, and only as a fallback. [`resolveGroupDetails`](../../components/Group/groupDetails.ts) treats all three `group_*` columns being null as "never saved" and parses the old blob out of this column instead, so a row that has not been backfilled still renders. Nothing writes it.

Both are dropped by **SCRUM-287**, once SCRUM-253 is deployed everywhere and [`scripts/backfill-group-preferences.ts`](../../../scripts/backfill-group-preferences.ts) has run. Until then they stay so that a schema deploy landing before the matching build cannot break the old code.

**As of 2026-08-31 the backfill is not finished, so SCRUM-287 is not yet safe.** Staging still holds 3 rows whose preferences exist only in `group_message`, and production is unknown — read access to the PlanetScale `main` branch was not available. The run-state table in [`scripts/README.md`](../../../scripts/README.md#run-state-record) is where that answer lives; check it, and the dry run, before dropping either column. While those rows exist, `resolveGroupDetails`'s fallback is the only thing keeping their content readable (SCRUM-307).

Lengths on the live path are enforced where every other one is: Zod on [`groups.updatePreferences`](../router/user/groups.ts), against the same constants the textarea uses. A failed save is now reported — [`useGroupDetails`](../../components/Group/useGroupDetails.ts) awaits `mutateAsync` and raises an error toast, replacing an `await mutate(...)` that resolved immediately and let the success toast fire regardless.

## Terms acceptance

`user.license_signed` records that a user accepted the liability disclaimer in [`CompliancePortal.tsx`](../../components/CompliancePortal.tsx). Those terms are written on behalf of Northeastern University and disclaim responsibility for rides, safety and data, so what this column means matters.

**It is trustworthy only for values written by `user.acceptTerms`.** Until SCRUM-240 nothing wrote it on acceptance at all: the "I Agree" button fired a Mixpanel event and closed the dialog, and the flag was set instead as a hardcoded side effect of every `user.edit` call. The modal was also rendered on the onboarding page alone, while [`index.tsx`](../../pages/index.tsx)'s `getServerSideProps` redirects to `/profile/setup` only when `isOnboarded` is false — so an already-onboarded user with no consent recorded never saw the terms, and their next profile save silently set the flag to `true`.

Since SCRUM-240: `user.acceptTerms` is the only writer, `user.edit` does not touch the column, and [`ComplianceGate`](../../components/ComplianceGate.tsx) is mounted once in `_app` so the terms appear on whichever page a user without consent lands on.

**Pre-existing rows were deliberately left as they are.** Forcing re-consent would put a blocking dialog in front of every active user, and the decision was that the disruption is not worth it. The consequence, which anyone relying on this column needs to know:

| Cohort                           | What `license_signed = true` means                                              |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Consent recorded after SCRUM-240 | The user clicked "I Agree" and the write succeeded                              |
| Rows set before SCRUM-240        | Either acceptance during onboarding **or** any profile save — indistinguishable |

There is no stored signal separating them, because the column carries no timestamp. Adding a timestamp and a terms version — which would also make re-consent possible when the terms are updated, something the terms text explicitly anticipates — needs new columns and is tracked separately. Do not treat a `true` predating that work as evidence for a specific user.

## Changing the schema

After editing `schema.prisma`:

```bash
yarn db:schema     # prisma migrate dev && prisma generate
```

This creates a migration, applies it to your local MySQL container, and regenerates the client. Commit the new folder under `prisma/migrations/` alongside your schema change.

Avoid `prisma db push`. It applies changes without recording a migration, which leaves your local database out of sync with the committed migration history.

### What migrations are for here, and what they are not

Two mechanisms exist, and they do different jobs. Conflating them is what caused SCRUM-227.

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

All three used a single `&` until SCRUM-304. That backgrounded `prisma generate` and started `next build` immediately, so the build could compile against whatever client `yarn install`'s postinstall happened to leave behind, and a failing `prisma generate` never reached the shell — only `next build`'s exit code did. A schema change that broke generation could therefore deploy green against a stale client, which is the SCRUM-227 failure mode arriving by a different route. `&&` is what all three meant.

That separation is deliberate and was reviewed in SCRUM-271. Adopting `prisma migrate deploy` for shared environments would need every shared branch baselined with `prisma migrate resolve --applied` for all existing migrations, and would bypass the online-schema-change and safe-migration behaviour a Deploy Request provides. It is not planned. If it is ever revisited, it needs its own ticket and a baselining plan.

So a schema change is two commits' worth of work in two places:

1. **In the repository** — edit `schema.prisma`, run `yarn db:schema`, commit the new folder under `prisma/migrations/`.
2. **In PlanetScale** — push the schema to staging, then open a Deploy Request to promote staging → `main`. A GitHub Action comments a reminder on any PR that touches `schema.prisma`.

Doing only the second is how `tutorial_completed` came to exist in every shared database while no migration created it, which meant a database built from migration history alone failed every `User` query with `P2022` — no sign-in and no account creation. See SCRUM-227.

### CI enforces step 1

The `schema` check ([`schema.yml`](../../../.github/workflows/schema.yml), SCRUM-271) replays the committed migration history into a throwaway MySQL 8.0 service container and fails if the result differs from `schema.prisma`:

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

### `build:preview` is gone, and why it had to be

The script was removed in SCRUM-249. It read:

```
build:preview = prisma generate && echo "y" | prisma db push && next build && prisma db seed
```

An earlier version of this section said "nothing invokes this script; every reference to it in the repository is a warning." That was true when the deploy configuration lived only in the Amplify console. It stopped being true once [`amplify.yml`](../../../amplify.yml) was committed, because the build phase ends in `yarn run build:${BUILD_ENV}` and `BUILD_ENV` is console-set — so `preview` was a reachable value, one console field away from running `prisma db push` and a re-seed against a deployed database.

Why that was the worst of the three build variants: `prisma db push` is step 2 of the table above and **has no host guard**, unlike `yarn seed`, which [`seedGuard.ts`](../../utils/seedGuard.ts) restricts to a localhost allowlist. Pointed at a shared database it would force-alter the schema successfully, and only the _seed_ at step 4 would be refused. The guard fires after the schema damage, not before it.

Deleting the script removes the reachable path entirely. The lesson generalises beyond this one entry: **a `package.json` script is part of the deploy surface whenever the build spec selects a script by variable.** The deny rules for `build:preview` in [`.claude/settings.json`](../../../.claude/settings.json) are deliberately left in place — they cost nothing now and would still fire if the script were ever reintroduced.

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
unit/suite detail — and per SCRUM-265 can store a neighborhood where the city
belongs — so collisions were realistic rather than theoretical.

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
  to. The correctness win is worth it, but it is relevant to SCRUM-176.
- These writes **are** transactional, since SCRUM-233. `resolveOwnedLocations`
  is called with the transaction client inside `ctx.prisma.$transaction` in
  [`user.edit`](../router/user.ts), so a failure part-way through rolls back the
  `user` row, both `location` rows and the `CarpoolSearch` together. Before
  that they were four independent awaits and a mid-sequence failure left them
  inconsistent permanently — `relationMode = "prisma"` means the database
  rejects none of it and there is no reconciliation job.
- Nothing in the database enforces the invariant. Giving `Location` an owning
  `carpoolSearchId` would, at the cost of a schema change, a PlanetScale deploy
  request and a backfill.
