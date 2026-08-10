# Database Layer

This directory holds the Prisma client the rest of the app shares. The schema, migrations, and seed script live at the repository root in [`prisma/`](../../../prisma).

- [`client.ts`](./client.ts) — creates and exports the `PrismaClient` singleton
- [`../../../prisma/schema.prisma`](../../../prisma/schema.prisma) — the data model
- [`../../../prisma/migrations/`](../../../prisma/migrations) — ordered SQL migrations
- [`../../../prisma/seed.ts`](../../../prisma/seed.ts) — generated data for local development

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
