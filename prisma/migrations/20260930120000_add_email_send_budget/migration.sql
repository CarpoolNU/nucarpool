-- CreateTable
CREATE TABLE `email_send_budget` (
    `user_id` VARCHAR(191) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `send_count` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`user_id`, `window_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
