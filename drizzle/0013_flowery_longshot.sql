ALTER TABLE `check_log` ADD `blocked_chat` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `blocked_at` integer;