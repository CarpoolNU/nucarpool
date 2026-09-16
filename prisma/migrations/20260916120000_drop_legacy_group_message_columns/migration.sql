/*
  Warnings:

  - You are about to drop the column `group_message` on the `carpool_search` table. All the data in the column will be lost.
  - You are about to drop the column `message` on the `group` table. All the data in the column will be lost.

  The contract half of 20260827150000_add_group_preference_columns, which added
  `group_notes`, `group_music_preference` and `group_conversation_style` as an
  expand-only change and left these two columns readable.

  Safe to drop because `scripts/backfill-group-preferences.ts --apply` has run
  in every environment: staging 3 rows, production 11, verified by a dry run
  reporting nothing to do and by comparing `group_notes` against the value the
  legacy read path resolved to, on 2026-09-16. `group.message` was never read by
  any code path -- `resolveGroupDetails` only ever read
  `carpool_search.group_message` -- so its copies were already unreachable.

  Note that `prisma/migrations/` is never applied to PlanetScale. This file is
  the committed record the `schema` CI check replays; the columns leave staging
  and `main` through `prisma db push` and a Deploy Request.
*/
-- AlterTable
ALTER TABLE `carpool_search` DROP COLUMN `group_message`;

-- AlterTable
ALTER TABLE `group` DROP COLUMN `message`;
