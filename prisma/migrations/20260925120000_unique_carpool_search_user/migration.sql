/*
  Makes `carpool_search.userId` unique: one CarpoolSearch per user, enforced by
  MySQL rather than assumed by the application. SCRUM-544, phase 1 of the
  SCRUM-543 design spike (docs/design/multi-carpool-search.md).

  `user.edit`'s find-or-create could race two first-time saves into two rows,
  and every reader picks "the" search with no `orderBy`. The index closes the
  race; `user.edit` retries a save that loses it.

  Fails on a table that already holds a duplicate `userId`. Production had none
  on 2026-09-23 - re-count immediately before the Deploy Request, since the
  race this closes could in principle have produced one since.

  The existing non-unique `carpool_search_userId_idx` is left in place. It is
  redundant now, and dropping it is a separate decision.

  Note that `prisma/migrations/` is never applied to PlanetScale. This file is
  the committed record the `schema` CI check replays; the index reaches
  staging and `main` through `prisma db push` and a Deploy Request.
*/
-- CreateIndex
CREATE UNIQUE INDEX `carpool_search_userId_key` ON `carpool_search`(`userId`);
