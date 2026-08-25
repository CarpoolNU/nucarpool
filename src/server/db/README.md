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

**Co-op dates — `startDate` / `endDate` (`DateTime? @db.Date`)**

A calendar day, taken by Prisma from the **UTC** date of whatever `Date` it is handed. Build these with [`lastDayOfMonthUTC`](../../utils/dateUtils.ts) rather than `new Date(year, month, 0)`: the local-time form stored the previous day for anyone at a positive UTC offset, because local midnight is the day before in UTC.

## Text lengths

MySQL runs in strict mode, so a value wider than its column makes the write **throw**, not truncate. Prisma surfaces that as `P2000` and tRPC turns it into an `INTERNAL_SERVER_ERROR` — a 500 for what is really a validation problem, raised after the UI has already accepted the text. Every Zod input that writes free text to a bounded column therefore carries a `.max()` matching that column (SCRUM-231).

An unannotated `String` on MySQL is `VARCHAR(191)`, which is why so many of these are 191 rather than something chosen.

| Column                                                  | Width          | Bounded by                                   | Limit                     |
| ------------------------------------------------------- | -------------- | -------------------------------------------- | ------------------------- |
| `message.content`                                       | `VARCHAR(255)` | `messages.sendMessage`, `requests.create`    | `MESSAGE_MAX_LENGTH`      |
| `user.bio`                                              | `VARCHAR(191)` | `user.edit`, `onboardSchema`                 | `PROFILE_TEXT_MAX_LENGTH` |
| `user.preferred_name`                                   | `VARCHAR(191)` | `user.edit`, `onboardSchema`                 | `PROFILE_TEXT_MAX_LENGTH` |
| `user.pronouns`                                         | `VARCHAR(191)` | `user.edit`, `onboardSchema`                 | `PROFILE_TEXT_MAX_LENGTH` |
| `carpool_search.company_name`                           | `VARCHAR(191)` | `user.edit`, `onboardSchema`                 | `PROFILE_TEXT_MAX_LENGTH` |
| `carpool_search.group_message`                          | `TEXT`         | —                                            | —                         |
| `group.message`                                         | `VARCHAR(191)` | — **see below**                              | —                         |
| `request.message`                                       | `VARCHAR(255)` | never written; `requests.create` stores `""` | —                         |
| `location.street`, `.street_address`, `.city`, `.state` | `VARCHAR(191)` | — parsed from a Mapbox feature, not typed    | —                         |

The values live in [`textLimits.ts`](../../utils/textLimits.ts) so the form, the tRPC input and the column cannot drift apart. Add a `.max()` there and reference it; do not write the number inline.

**`group.message` is not yet bounded, and it can overflow today.** `GroupPage` serialises the whole driver-preferences form into it as `GROUP_DETAILS_V1:{…json…}`, which costs ~87 characters of prefix and JSON structure before any content. A 90-character note plus two of the fixed preference options already exceeds 191, and the save fails with no error shown — `updateMessage` has no `onError`, and the success toast fires from the click handler regardless. The column was widened to `TEXT` by `20241119202706_add_text_type` and then narrowed back to `VARCHAR(191)` by `20251114054152_add_location_table`, because `CarpoolGroup.message` in `schema.prisma` is a plain `String`. Restoring `@db.Text` is the fix, and it needs a migration and a PlanetScale deploy request.

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

**Migration files are not applied to PlanetScale.** Nothing in the deploy pipeline runs `prisma migrate deploy` — the Amplify build runs `prisma generate` and `next build`, and PlanetScale Deploy Requests diff branch schemas without reading `prisma/migrations/` or `_prisma_migrations`. Migration history exists so that _anything built from the repository_ reproduces `schema.prisma`: a fresh clone, a CI database, a restore, a new branch.

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

### `build:preview` remains a hazard

```
build:preview = prisma generate && echo "y" | prisma db push && next build && prisma db seed
```

Nothing invokes this script; every reference to it in the repository is a warning. It is worth knowing why it is dangerous anyway: `prisma db push` is step 2 and **has no host guard**, unlike `yarn seed`, which [`seedGuard.ts`](../../utils/seedGuard.ts) restricts to a localhost allowlist. Pointed at a shared database it would force-alter the schema successfully, and only the _seed_ at step 4 would be refused. The guard fires after the schema damage, not before it.

Removing the script is tracked in SCRUM-249.

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

### Consequences to know about

- Two users at the same company now hold two rows rather than one. List queries
  such as `geoJsonUserList` therefore read more `location` rows than they used
  to. The correctness win is worth it, but it is relevant to SCRUM-176.
- These writes are still **not transactional**. A failure between the location
  write and the `CarpoolSearch` write leaves the two inconsistent, same as
  before this change. Tracked as SCRUM-233.
- Nothing in the database enforces the invariant. Giving `Location` an owning
  `carpoolSearchId` would, at the cost of a schema change, a PlanetScale deploy
  request and a backfill.
