/*
  Records when the terms were accepted and which wording was accepted, so
  `user.license_signed` stops being the only evidence of a disclaimer written
  on behalf of Northeastern University. SCRUM-280.

  Both columns are nullable and neither is backfilled. There is no timestamp
  to recover for rows that predate them and no version to infer -- the wording
  those users saw is unknown, which is precisely the gap "Terms acceptance" in
  `src/server/db/README.md` describes. Null is therefore the record, not a hole
  in it: it identifies the untrusted cohort exactly, which is what makes a
  targeted re-consent possible for the first time.

  The existing boolean is deliberately kept. It is the only acceptance record
  those rows have, and dropping it would need an expand/backfill/contract cycle
  with nothing to backfill from.

  Non-destructive: two nullable ADD COLUMNs, no default, no rewrite of existing
  values.

  Note that `prisma/migrations/` is never applied to PlanetScale. This file is
  the committed record the `schema` CI check replays; the columns reach staging
  and `main` through `prisma db push` and a Deploy Request.
*/
-- AlterTable
ALTER TABLE `user` ADD COLUMN `license_signed_at` DATETIME(3) NULL,
    ADD COLUMN `license_version` VARCHAR(32) NULL;
