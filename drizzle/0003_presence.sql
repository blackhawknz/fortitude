CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`world_id` text NOT NULL,
	`player_id` text NOT NULL,
	`tick` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`delivered` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_world` ON `notifications` (`world_id`,`read`,`tick`);--> statement-breakpoint
CREATE TABLE `player_presence` (
	`world_id` text PRIMARY KEY NOT NULL,
	`last_seen_tick` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	`last_teaser_at` integer,
	`last_teaser_tick` integer
);
