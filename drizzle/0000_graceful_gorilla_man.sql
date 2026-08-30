CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`uid` text NOT NULL,
	`title` text NOT NULL,
	`venue` text,
	`city` text,
	`date_text` text,
	`starts_at` integer,
	`url` text NOT NULL,
	`image` text,
	`price_from` text,
	`price_to` text,
	`currency` text DEFAULT 'BYN',
	`on_sale` integer DEFAULT false,
	`status` text DEFAULT 'unknown',
	`first_seen_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	`last_checked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_events_source_uid` ON `events` (`source`,`uid`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`event_id` integer,
	`dedupe_key` text NOT NULL,
	`sent_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_notif_chat_key` ON `notifications` (`chat_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `users` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`username` text,
	`first_name` text,
	`created_at` integer DEFAULT (unixepoch()),
	`last_seen_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `watch_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`kind` text DEFAULT 'query' NOT NULL,
	`source` text DEFAULT 'all' NOT NULL,
	`query` text NOT NULL,
	`event_url` text,
	`title` text,
	`active` integer DEFAULT true,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `idx_watch_chat` ON `watch_items` (`chat_id`,`active`);