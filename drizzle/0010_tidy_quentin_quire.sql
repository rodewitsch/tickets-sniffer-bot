CREATE TABLE `venue_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`watch_item_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`slug` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`failing` integer DEFAULT false,
	`cursor` integer DEFAULT 0,
	`due_at` integer DEFAULT 0 NOT NULL,
	`last_crawled_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_venue_queue_item_slug` ON `venue_queue` (`watch_item_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_venue_queue_due` ON `venue_queue` (`due_at`);--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_queued` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_queue_waiting` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_queue_crawled` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_queue_failed` integer DEFAULT 0;