ALTER TABLE `check_log` ADD `city_checks` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `city_probes_max` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_quota_hit` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_crawl_time_truncated` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_crawl_budget_truncated` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_crawl_deferred` integer DEFAULT 0;