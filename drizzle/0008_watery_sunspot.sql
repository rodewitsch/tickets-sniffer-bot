ALTER TABLE `check_log` ADD `skipped_fresh` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `no_budget` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `empty_result` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `not_on_sale` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `error_items` integer DEFAULT 0;