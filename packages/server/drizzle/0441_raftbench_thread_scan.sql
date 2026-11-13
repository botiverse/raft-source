ALTER TABLE "raftbench_configs" ADD COLUMN "thread_read_messages" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "raftbench_configs" ADD COLUMN "thread_read_through_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "raftbench_configs" ADD COLUMN "thread_scanned_through_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raftbench_configs" ADD COLUMN "source_scan_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "raftbench_latest_runs" ADD COLUMN "source_kind" text DEFAULT 'channel' NOT NULL;