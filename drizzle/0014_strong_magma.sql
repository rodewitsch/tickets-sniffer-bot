CREATE TABLE `muted_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`title` text,
	`date_text` text,
	`muted_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_muted_chat_key` ON `muted_events` (`chat_id`,`dedupe_key`);