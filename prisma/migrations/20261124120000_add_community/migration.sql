-- CreateTable
CREATE TABLE `community_category` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(32) NOT NULL,
    `name` VARCHAR(48) NOT NULL,
    `description` VARCHAR(191) NOT NULL DEFAULT '',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `community_category_slug_key`(`slug`),
    INDEX `community_category_is_active_sort_order_idx`(`is_active`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_profile` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `handle` VARCHAR(24) NOT NULL,
    `handle_normalized` VARCHAR(24) NOT NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `community_profile_user_id_key`(`user_id`),
    UNIQUE INDEX `community_profile_handle_normalized_key`(`handle_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_post` (
    `id` VARCHAR(191) NOT NULL,
    `author_id` VARCHAR(191) NOT NULL,
    `category_id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(150) NOT NULL,
    `content` VARCHAR(5000) NOT NULL,
    `vote_count` INTEGER NOT NULL DEFAULT 0,
    `comment_count` INTEGER NOT NULL DEFAULT 0,
    `hidden_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `edited_at` DATETIME(3) NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `community_post_category_id_date_created_id_idx`(`category_id`, `date_created`, `id`),
    INDEX `community_post_category_id_vote_count_id_idx`(`category_id`, `vote_count`, `id`),
    INDEX `community_post_author_id_date_created_id_idx`(`author_id`, `date_created`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_comment` (
    `id` VARCHAR(191) NOT NULL,
    `post_id` VARCHAR(191) NOT NULL,
    `author_id` VARCHAR(191) NOT NULL,
    `content` VARCHAR(2000) NOT NULL,
    `hidden_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `edited_at` DATETIME(3) NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `community_comment_post_id_date_created_id_idx`(`post_id`, `date_created`, `id`),
    INDEX `community_comment_author_id_idx`(`author_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_post_vote` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `post_id` VARCHAR(191) NOT NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `community_post_vote_post_id_idx`(`post_id`),
    UNIQUE INDEX `community_post_vote_user_id_post_id_key`(`user_id`, `post_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_saved_post` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `post_id` VARCHAR(191) NOT NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `community_saved_post_user_id_date_created_id_idx`(`user_id`, `date_created`, `id`),
    INDEX `community_saved_post_post_id_idx`(`post_id`),
    UNIQUE INDEX `community_saved_post_user_id_post_id_key`(`user_id`, `post_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_report` (
    `id` VARCHAR(191) NOT NULL,
    `reporter_id` VARCHAR(191) NOT NULL,
    `reported_user_id` VARCHAR(191) NOT NULL,
    `target_type` ENUM('POST', 'COMMENT') NOT NULL,
    `target_id` VARCHAR(191) NOT NULL,
    `reason` ENUM('HARASSMENT', 'SPAM', 'MISINFORMATION', 'OFF_TOPIC', 'SAFETY_CONCERN', 'OTHER') NOT NULL,
    `message` VARCHAR(500) NULL,
    `content_snapshot` TEXT NULL,
    `status` ENUM('OPEN', 'REVIEWED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `reviewed_by_id` VARCHAR(191) NULL,
    `review_note` VARCHAR(500) NULL,
    `date_created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `date_modified` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `community_report_status_date_created_idx`(`status`, `date_created`),
    INDEX `community_report_target_type_target_id_idx`(`target_type`, `target_id`),
    INDEX `community_report_reported_user_id_idx`(`reported_user_id`),
    UNIQUE INDEX `community_report_reporter_id_target_type_target_id_key`(`reporter_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `community_action_budget` (
    `user_id` VARCHAR(191) NOT NULL,
    `action` ENUM('HANDLE_CLAIM', 'POST_CREATE', 'COMMENT_CREATE', 'VOTE', 'SAVE', 'REPORT_CREATE', 'CONTENT_EDIT', 'CONTENT_DELETE') NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`user_id`, `action`, `window_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

