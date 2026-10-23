ALTER TABLE `watch_items` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `watch_items` ADD `defer_streak` integer DEFAULT 0;