CREATE TABLE `rating_field` (
	`key` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `program` ADD `ratings` text;--> statement-breakpoint
ALTER TABLE `program_grouping` ADD `ratings` text;