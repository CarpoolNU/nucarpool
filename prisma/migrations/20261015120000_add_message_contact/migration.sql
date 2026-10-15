-- CreateTable
CREATE TABLE `message_contact` (
    `id` VARCHAR(191) NOT NULL,
    `user_a_id` VARCHAR(191) NOT NULL,
    `user_b_id` VARCHAR(191) NOT NULL,
    `ended_at` DATETIME(3) NOT NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `message_contact_user_a_id_ended_at_idx`(`user_a_id`, `ended_at`),
    INDEX `message_contact_user_b_id_ended_at_idx`(`user_b_id`, `ended_at`),
    INDEX `message_contact_ended_at_idx`(`ended_at`),
    UNIQUE INDEX `message_contact_user_a_id_user_b_id_key`(`user_a_id`, `user_b_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
