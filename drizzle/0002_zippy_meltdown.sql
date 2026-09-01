CREATE TABLE `check_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer DEFAULT (unixepoch()),
	`checked` integer DEFAULT 0 NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `idx_check_log_started` ON `check_log` (`started_at`);