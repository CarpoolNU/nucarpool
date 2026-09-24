/*
  Adds the `block` and `report` tables, so a user can block another user and
  report them to an admin. SCRUM-553, phase 1 of SCRUM-532.

  Schema only. Nothing reads or writes either table yet; phases 2 and 3 do.
  Those phases read `block` on every recommendations and map request, so this
  change must reach production before either of them deploys.

  `report.request_id` is deliberately a plain column with no relation, and
  `report.conversation_snapshot` holds a copy of the thread: either party can
  delete the request a report points at, and that deletes the conversation and
  its messages too. The comment on `Report` in `schema.prisma` has the detail.

  Non-destructive: two CREATE TABLEs, no change to any existing table or row.

  Note that `prisma/migrations/` is never applied to PlanetScale. This file is
  the committed record the `schema` CI check replays; the tables reach staging
  and `main` through `prisma db push` and a Deploy Request.
*/
-- CreateTable
CREATE TABLE `block` (
    `id` VARCHAR(191) NOT NULL,
    `blocker_id` VARCHAR(191) NOT NULL,
    `blocked_id` VARCHAR(191) NOT NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `block_blocked_id_idx`(`blocked_id`),
    UNIQUE INDEX `block_blocker_id_blocked_id_key`(`blocker_id`, `blocked_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report` (
    `id` VARCHAR(191) NOT NULL,
    `reporter_id` VARCHAR(191) NOT NULL,
    `reported_user_id` VARCHAR(191) NOT NULL,
    `reason` ENUM('SAFETY_CONCERN', 'HARASSMENT', 'INAPPROPRIATE_MESSAGES', 'FAKE_PROFILE', 'NO_SHOW', 'OTHER') NOT NULL,
    `message` VARCHAR(500) NULL,
    `request_id` VARCHAR(191) NULL,
    `conversation_snapshot` TEXT NULL,
    `status` ENUM('OPEN', 'REVIEWED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `date_modified` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `report_reporter_id_idx`(`reporter_id`),
    INDEX `report_reported_user_id_idx`(`reported_user_id`),
    INDEX `report_status_date_created_idx`(`status`, `date_created`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
