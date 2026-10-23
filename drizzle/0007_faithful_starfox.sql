ALTER TABLE `check_log` ADD `search_cache_hits` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `search_cache_misses` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `search_cache_joins` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `presale_skipped` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `per_chat_denied` integer DEFAULT 0;