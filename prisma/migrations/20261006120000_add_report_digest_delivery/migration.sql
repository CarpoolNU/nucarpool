-- CreateTable
CREATE TABLE `report_digest_delivery` (
    `window_start` DATETIME(3) NOT NULL,
    `window_end` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'CLAIMED', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `claim_token` VARCHAR(64) NULL,
    `claimed_at` DATETIME(3) NULL,
    `sent_at` DATETIME(3) NULL,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `report_count` INTEGER NULL,
    `recipient_count` INTEGER NULL,

    PRIMARY KEY (`window_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
