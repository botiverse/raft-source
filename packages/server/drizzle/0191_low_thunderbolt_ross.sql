CREATE TABLE "wiki_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"wiki_space_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"current_understanding" text,
	"status" text DEFAULT 'tentative' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"source_policy" text DEFAULT 'cached_summary' NOT NULL,
	"s3_key" text NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"time_range_start" timestamp with time zone,
	"time_range_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"wiki_space_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"progress" jsonb,
	"error" text,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_source_coverage" (
	"wiki_space_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"covered_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_source_coverage_wiki_space_id_channel_id_pk" PRIMARY KEY("wiki_space_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"wiki_agent_id" uuid NOT NULL,
	"wiki_channel_id" uuid NOT NULL,
	"status" text DEFAULT 'ready_uninitialized' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"initialized_at" timestamp with time zone,
	"last_scanned_seq" bigint DEFAULT 0 NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_artifacts" ADD CONSTRAINT "wiki_artifacts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_artifacts" ADD CONSTRAINT "wiki_artifacts_wiki_space_id_wiki_spaces_id_fk" FOREIGN KEY ("wiki_space_id") REFERENCES "public"."wiki_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_jobs" ADD CONSTRAINT "wiki_jobs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_jobs" ADD CONSTRAINT "wiki_jobs_wiki_space_id_wiki_spaces_id_fk" FOREIGN KEY ("wiki_space_id") REFERENCES "public"."wiki_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_source_coverage" ADD CONSTRAINT "wiki_source_coverage_wiki_space_id_wiki_spaces_id_fk" FOREIGN KEY ("wiki_space_id") REFERENCES "public"."wiki_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_source_coverage" ADD CONSTRAINT "wiki_source_coverage_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_spaces" ADD CONSTRAINT "wiki_spaces_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_spaces" ADD CONSTRAINT "wiki_spaces_wiki_agent_id_agents_id_fk" FOREIGN KEY ("wiki_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_spaces" ADD CONSTRAINT "wiki_spaces_wiki_channel_id_channels_id_fk" FOREIGN KEY ("wiki_channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_spaces" ADD CONSTRAINT "wiki_spaces_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wiki_artifacts_space_slug" ON "wiki_artifacts" USING btree ("wiki_space_id","slug");--> statement-breakpoint
CREATE INDEX "idx_wiki_artifacts_server_type" ON "wiki_artifacts" USING btree ("server_id","artifact_type");--> statement-breakpoint
CREATE INDEX "idx_wiki_artifacts_space_type" ON "wiki_artifacts" USING btree ("wiki_space_id","artifact_type");--> statement-breakpoint
CREATE INDEX "idx_wiki_artifacts_updated" ON "wiki_artifacts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_wiki_jobs_server_created" ON "wiki_jobs" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_wiki_jobs_space_created" ON "wiki_jobs" USING btree ("wiki_space_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_wiki_jobs_status" ON "wiki_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wiki_jobs_one_active_per_space" ON "wiki_jobs" USING btree ("wiki_space_id") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wiki_spaces_server" ON "wiki_spaces" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_wiki_spaces_agent" ON "wiki_spaces" USING btree ("wiki_agent_id");--> statement-breakpoint
CREATE INDEX "idx_wiki_spaces_channel" ON "wiki_spaces" USING btree ("wiki_channel_id");--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'wiki_v0',
	'Wiki v0 platform rollout gate',
	true,
	false,
	'server',
	false,
	NULL,
	'wiki_v0'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "feature_flag_rules" (
	"id",
	"flag_key",
	"stage",
	"priority",
	"decision",
	"values"
) VALUES (
	'b7ba66b6-47da-4aa6-84c4-0e24c61eae80',
	'wiki_v0',
	'server',
	0,
	'allow',
	'["95f993fa-2a68-4797-b8ae-7beb7d984ada"]'::jsonb
) ON CONFLICT ("id") DO NOTHING;
