ALTER TABLE `check_log` ADD `detail_spent` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `detail_denied` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `city_probes` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `query_venues_tried` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `query_venues_skipped` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_crawl_truncated` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_crawl_ms` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_crawl_runs` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_events_truncated` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_events_seen` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `venue_events_past_skipped` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `check_log` ADD `results_truncated` integer DEFAULT 0;