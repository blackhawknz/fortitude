CREATE TABLE `external_sync` (
	`world_id` text NOT NULL,
	`kind` text NOT NULL,
	`local_id` integer NOT NULL,
	`external_ref` text NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`world_id`, `kind`, `local_id`)
);
