/*
  One-shot marker for the acceptance notification email. SCRUM-564, found
  while implementing SCRUM-559 (request and message markers).

  `sendAcceptanceNotification` had no marker at all, so the person who
  accepted a request could call it in a loop and mail the requester
  "<name> accepted your carpool request" every time. `markRequestAccepted`
  now sets this column in the same statement that flips `status` to
  `ACCEPTED`, and the procedure clears it in one conditional `UPDATE` before
  sending, the same primitive `notificationPendingSince` and
  `notificationPending` use — see the "Notification markers" section of
  `src/server/db/README.md`.

  Nullable with no default, so it defaults to "nothing owed" and no backfill
  is needed: every row accepted before this migration keeps a null marker and
  can never send. Additive, so the code running before this ships is
  unaffected by it; the code that reads the column must not deploy ahead of
  it, the same ordering constraint `notificationPendingSince` has.

  Note that `prisma/migrations/` is never applied to PlanetScale. This file is
  the committed record the `schema` CI check replays; the column reaches
  staging and `main` through `prisma db push` and a Deploy Request.
*/
-- AlterTable
ALTER TABLE `request` ADD COLUMN `acceptanceNotificationPendingSince` DATETIME(3) NULL;
