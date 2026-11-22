CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`author_name` text,
	`author_username` text,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`owner_msg_id` integer,
	`message_id` integer,
	`reply_text` text,
	`answered_at` integer,
	`status` text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_status` ON `feedback` (`status`,`created_at`);