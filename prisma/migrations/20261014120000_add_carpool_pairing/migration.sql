-- CreateTable
CREATE TABLE `carpool_pairing` (
    `id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `user_a_id` VARCHAR(191) NOT NULL,
    `user_b_id` VARCHAR(191) NOT NULL,
    `driver_id` VARCHAR(191) NULL,
    `formed_at` DATETIME(3) NULL,
    `ended_at` DATETIME(3) NOT NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `carpool_pairing_user_a_id_ended_at_idx`(`user_a_id`, `ended_at`),
    INDEX `carpool_pairing_user_b_id_ended_at_idx`(`user_b_id`, `ended_at`),
    INDEX `carpool_pairing_ended_at_idx`(`ended_at`),
    INDEX `carpool_pairing_group_id_idx`(`group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

