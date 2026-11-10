PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_external_collection_programs` (
	`uuid` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`position` integer,
	`upstream_entry_id` text,
	`video_id` text,
	`status` text DEFAULT 'available' NOT NULL,
	`message` text,
	`collection_id` text NOT NULL,
	`program_id` text,
	`grouping_id` text,
	FOREIGN KEY (`collection_id`) REFERENCES `external_collections`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`program_id`) REFERENCES `program`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grouping_id`) REFERENCES `program_grouping`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Copy only columns present in the old table; defaults create stable local IDs.
INSERT INTO `__new_external_collection_programs`("collection_id", "program_id", "grouping_id") SELECT "collection_id", "program_id", "grouping_id" FROM `external_collection_programs`;--> statement-breakpoint
DROP TABLE `external_collection_programs`;--> statement-breakpoint
ALTER TABLE `__new_external_collection_programs` RENAME TO `external_collection_programs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `external_collection_legacy_program_unique` ON `external_collection_programs` (`collection_id`,`program_id`) WHERE "external_collection_programs"."position" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `external_collection_position_unique` ON `external_collection_programs` (`collection_id`,`position`) WHERE "external_collection_programs"."position" is not null;--> statement-breakpoint
CREATE INDEX `external_collection_program_idx` ON `external_collection_programs` (`program_id`);--> statement-breakpoint
ALTER TABLE `external_collections` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `external_collections` ADD `last_successful_refresh_at` integer;--> statement-breakpoint
ALTER TABLE `external_collections` ADD `last_refresh_error` text;