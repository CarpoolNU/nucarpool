-- AlterTable
ALTER TABLE `carpool_search` ADD COLUMN `group_conversation_style` VARCHAR(40) NULL,
    ADD COLUMN `group_music_preference` VARCHAR(40) NULL,
    ADD COLUMN `group_notes` VARCHAR(90) NULL;
