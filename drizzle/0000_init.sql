CREATE TABLE `agent_goals` (
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`id` text NOT NULL,
	`text` text NOT NULL,
	`weight` real NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`perceived_progress` real,
	`note` text,
	`created_tick` integer DEFAULT 0 NOT NULL,
	`resolved_tick` integer,
	PRIMARY KEY(`world_id`, `agent_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `agent_memory_episodic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`text` text NOT NULL,
	`importance` integer NOT NULL,
	`tick` integer NOT NULL,
	`private` integer DEFAULT true NOT NULL,
	`origin` text NOT NULL,
	`source_event_id` text
);
--> statement-breakpoint
CREATE INDEX `mem_epi_agent_tick` ON `agent_memory_episodic` (`world_id`,`agent_id`,`tick`);--> statement-breakpoint
CREATE TABLE `agent_memory_semantic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text,
	`weight` real DEFAULT 1 NOT NULL,
	`updated_tick` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mem_sem_agent` ON `agent_memory_semantic` (`world_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`tick` integer NOT NULL,
	`kind` text NOT NULL,
	`backend` text NOT NULL,
	`trigger_json` text NOT NULL,
	`packet_json` text NOT NULL,
	`response_json` text,
	`status` text NOT NULL,
	`error` text,
	`latency_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turns_agent` ON `agent_turns` (`world_id`,`agent_id`,`tick`);--> statement-breakpoint
CREATE INDEX `turns_time` ON `agent_turns` (`world_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agents` (
	`world_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`personality` text NOT NULL,
	`backstory` text NOT NULL,
	`portrait` text,
	`backend` text NOT NULL,
	`budget_json` text DEFAULT '{}' NOT NULL,
	`traits_json` text NOT NULL,
	`alive` integer DEFAULT true NOT NULL,
	`health` real NOT NULL,
	`stress` real NOT NULL,
	`mood` text NOT NULL,
	`mood_tick` integer DEFAULT 0 NOT NULL,
	`location_id` text NOT NULL,
	`activity` text NOT NULL,
	`asleep` integer DEFAULT false NOT NULL,
	`working` integer DEFAULT false NOT NULL,
	`inventory_json` text DEFAULT '[]' NOT NULL,
	`injured_until` integer,
	`agent_mood` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`world_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `betrayals` (
	`world_id` text NOT NULL,
	`id` text NOT NULL,
	`betrayer` text NOT NULL,
	`victim` text NOT NULL,
	`listener` text NOT NULL,
	`fact_id` text NOT NULL,
	`tick` integer NOT NULL,
	`discovered` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`world_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `event_visibility` (
	`world_id` text NOT NULL,
	`event_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`tick` integer NOT NULL,
	PRIMARY KEY(`event_id`, `agent_id`)
);
--> statement-breakpoint
CREATE INDEX `evvis_agent_tick` ON `event_visibility` (`world_id`,`agent_id`,`tick`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`tick` integer NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`target_id` text,
	`location_id` text,
	`outcome` text,
	`text` text NOT NULL,
	`magnitude` real NOT NULL,
	`private_to` text,
	`data_json` text
);
--> statement-breakpoint
CREATE INDEX `events_world_tick` ON `events` (`world_id`,`tick`);--> statement-breakpoint
CREATE TABLE `intents` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text,
	`to_location` text,
	`payload_json` text,
	`reason` text NOT NULL,
	`weight` real NOT NULL,
	`source` text NOT NULL,
	`created_tick` integer NOT NULL,
	`expires_tick` integer NOT NULL,
	`applied_tick` integer,
	`status` text NOT NULL,
	`reject_reason` text,
	`submitted_at` integer
);
--> statement-breakpoint
CREATE INDEX `intents_status` ON `intents` (`world_id`,`status`,`expires_tick`);--> statement-breakpoint
CREATE INDEX `intents_applied` ON `intents` (`world_id`,`applied_tick`);--> statement-breakpoint
CREATE TABLE `journals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`day` integer NOT NULL,
	`text` text NOT NULL,
	`discoverable` integer DEFAULT true NOT NULL,
	`discovered_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_agent_day` ON `journals` (`world_id`,`agent_id`,`day`);--> statement-breakpoint
CREATE TABLE `knowledge` (
	`world_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`fact_id` text NOT NULL,
	`tick` integer NOT NULL,
	`source_json` text NOT NULL,
	PRIMARY KEY(`world_id`, `agent_id`, `fact_id`)
);
--> statement-breakpoint
CREATE TABLE `locations` (
	`world_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`kind` text NOT NULL,
	`color` text NOT NULL,
	`condition` real NOT NULL,
	`dark` integer DEFAULT false NOT NULL,
	`sealed_until` integer,
	PRIMARY KEY(`world_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `relationships` (
	`world_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`trust` real NOT NULL,
	`warmth` real NOT NULL,
	`tension` real NOT NULL,
	`grudge` real DEFAULT 0 NOT NULL,
	`encounters` integer NOT NULL,
	`type` text NOT NULL,
	`last_tick` integer,
	`history_json` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`world_id`, `from_id`, `to_id`)
);
--> statement-breakpoint
CREATE TABLE `station` (
	`world_id` text PRIMARY KEY NOT NULL,
	`hull` real NOT NULL,
	`reported_hull` real NOT NULL,
	`power` real NOT NULL,
	`air` real NOT NULL,
	`water` real NOT NULL,
	`morale` real NOT NULL,
	`incidents_json` text DEFAULT '[]' NOT NULL,
	`last_incident_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worlds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`seed` text NOT NULL,
	`tick` integer DEFAULT 0 NOT NULL,
	`speed_ms` integer DEFAULT 10000 NOT NULL,
	`running` integer DEFAULT false NOT NULL,
	`settings_json` text NOT NULL,
	`extra_json` text DEFAULT '{}' NOT NULL,
	`last_tick_at` integer,
	`created_at` integer NOT NULL
);
