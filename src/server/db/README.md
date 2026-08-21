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

## Changing the schema

After editing `schema.prisma`:

```bash
yarn db:schema     # prisma migrate dev && prisma generate
```

This creates a migration, applies it to your local MySQL container, and regenerates the client. Commit the new folder under `prisma/migrations/` alongside your schema change.

Avoid `prisma db push`. It applies changes without recording a migration, which leaves your local database out of sync with the committed migration history.

Schema changes also require a PlanetScale deploy request before merging — a GitHub Action comments on any PR that touches `schema.prisma`.

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
