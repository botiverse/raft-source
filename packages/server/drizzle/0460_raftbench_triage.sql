CREATE TABLE "raftbench_message_labels" (
	"server_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"storage_channel_id" uuid NOT NULL,
	"target" text NOT NULL,
	"source_version" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"triaged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raftbench_triage_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"message_refs" jsonb NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"weighted_tokens" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "raftbench_message_labels" ADD CONSTRAINT "raftbench_message_labels_server_id_raftbench_configs_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."raftbench_configs"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raftbench_triage_batches" ADD CONSTRAINT "raftbench_triage_batches_server_id_raftbench_configs_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."raftbench_configs"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_raftbench_message_label" ON "raftbench_message_labels" USING btree ("server_id","revision","message_id");--> statement-breakpoint
CREATE INDEX "idx_raftbench_triage_batch_status" ON "raftbench_triage_batches" USING btree ("server_id","status","started_at");--> statement-breakpoint
CREATE INDEX "idx_raftbench_triage_batch_started" ON "raftbench_triage_batches" USING btree ("started_at");