/*
  One-shot markers for the request and message notification emails.
  SCRUM-559, phase 3 of the SCRUM-556 audit.

  Nothing recorded that a notification had gone out, so both procedures could
  be called in a loop and would mail the recipient each time. Each column marks
  an email that is still owed, and the procedure clears it in a conditional
  update before sending. Only one caller's update can match, so only one email
  goes out.

  Both columns default to "nothing owed", so no backfill is needed. A row
  written before this migration can never trigger an email. A `notifiedAt` that
  is null until sent would have done the reverse, and made every existing
  request and message sendable once.

  Additive and nullable/defaulted, so the code running before this ships is
  unaffected by it. The code that reads the columns must not deploy ahead of
  them: `requests.create` writes `notificationPendingSince` and fails without it.

  Note that `prisma/migrations/` is never applied to PlanetScale. This file is
  the committed record the `schema` CI check replays; the columns reach
  staging and `main` through `prisma db push` and a Deploy Request.
*/
-- AlterTable
ALTER TABLE `request` ADD COLUMN `notificationPendingSince` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `message` ADD COLUMN `notificationPending` BOOLEAN NOT NULL DEFAULT false;
