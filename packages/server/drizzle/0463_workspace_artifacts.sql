-- Workspace Artifacts (docs/development/workspace-artifacts.md), the
-- feature branch's one migration: the app's own schema `app_artifacts`, core's
-- object events (`object_events`, `object_event_recipients`), core's object
-- Activity rows (`object_inbox_states`) and the `workspace_artifacts_v0` flag
-- row. It replaces the branch's ten migrations
-- (0438_workspace_artifacts_flag ... 0447_object_event_homes_recipients,
-- squashed 2026-10-24, xxchan and Tenny in #proj-workspace:c4bea552); an
-- empty database migrated either way has the same schema. Until the branch
-- lands, a schema change on it edits this file (and its snapshot, by
-- drizzle-kit) rather than adding a migration; a database that ran an
-- earlier form of it is rebuilt.
--
-- Bounded lock wait: the foreign keys to core's channels, servers and
-- attachments take a SHARE ROW EXCLUSIVE lock on them; if a long transaction
-- holds one, give up after 5s (the deploy retries) instead of queueing every
-- write to it behind this.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Server-scoped, default off, no rules: while off, a server is today's Raft.
-- Rules are added in FFA per server.
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
	'workspace_artifacts_v0',
	'Workspace Artifacts as native Raft objects rollout gate',
	true,
	false,
	'server',
	false,
	NULL,
	'workspace_artifacts_v0'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE SCHEMA "app_artifacts";
--> statement-breakpoint
CREATE TABLE "object_event_recipients" (
	"event_id" uuid NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "object_event_recipients_event_id_recipient_type_recipient_id_pk" PRIMARY KEY("event_id","recipient_type","recipient_id"),
	CONSTRAINT "object_event_recipients_type" CHECK ("object_event_recipients"."recipient_type" IN ('user', 'agent')),
	CONSTRAINT "object_event_recipients_reason" CHECK ("object_event_recipients"."reason" IN ('mentioned', 'following', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "object_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"server_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"home_kind" text,
	"home_channel_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_events_home_kind" CHECK ("object_events"."home_kind" IS NULL OR "object_events"."home_kind" IN ('conversation', 'server', 'public')),
	CONSTRAINT "object_events_home_channel" CHECK ("object_events"."home_channel_id" IS NULL OR "object_events"."home_kind" = 'conversation'),
	CONSTRAINT "object_events_actor_type" CHECK ("object_events"."actor_type" IN ('user', 'agent')),
	CONSTRAINT "object_events_data_small" CHECK (pg_column_size("object_events"."data") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "object_inbox_states" (
	"user_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"server_id" uuid NOT NULL,
	"home_kind" text NOT NULL,
	"home_channel_id" uuid,
	"last_event_id" uuid NOT NULL,
	"last_event_seq" bigint NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"last_mention_seq" bigint,
	"read_through_seq" bigint,
	"done_through_seq" bigint,
	"done_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_inbox_states_user_id_object_kind_object_id_pk" PRIMARY KEY("user_id","object_kind","object_id"),
	CONSTRAINT "object_inbox_states_home_kind" CHECK ("object_inbox_states"."home_kind" IN ('conversation', 'server', 'public')),
	CONSTRAINT "object_inbox_states_home_channel" CHECK ("object_inbox_states"."home_channel_id" IS NULL OR "object_inbox_states"."home_kind" = 'conversation')
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."attachment_saves" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"r2_key" text NOT NULL,
	"quota_month" text,
	"quota_reserved_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_state" CHECK ("app_artifacts"."blobs"."state" IN ('pending', 'ready')),
	CONSTRAINT "blobs_quota_reservation" CHECK (("app_artifacts"."blobs"."quota_month" IS NULL) = ("app_artifacts"."blobs"."quota_reserved_bytes" IS NULL) AND ("app_artifacts"."blobs"."quota_month" IS NULL OR "app_artifacts"."blobs"."state" = 'pending'))
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."comments" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version_id" text NOT NULL,
	"path" text,
	"anchor" jsonb,
	"reply_to" text,
	"author_type" text NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"copied_from" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"position" bigint NOT NULL,
	CONSTRAINT "comments_anchor_needs_path" CHECK ("app_artifacts"."comments"."path" IS NOT NULL OR "app_artifacts"."comments"."anchor" IS NULL),
	CONSTRAINT "comments_author_type" CHECK ("app_artifacts"."comments"."author_type" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."items" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"url_key" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"icon" text,
	"current_version_id" text,
	"home_kind" text NOT NULL,
	"home_channel_id" uuid,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_position" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "items_url_key_unique" UNIQUE("url_key"),
	CONSTRAINT "items_home_kind" CHECK ("app_artifacts"."items"."home_kind" IN ('conversation', 'server', 'public')),
	CONSTRAINT "items_home_channel" CHECK ("app_artifacts"."items"."home_kind" = 'conversation' OR "app_artifacts"."items"."home_channel_id" IS NULL),
	CONSTRAINT "items_created_by_type" CHECK ("app_artifacts"."items"."created_by_type" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."pending_notices" (
	"item_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"comment_ids" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_notices_item_id_agent_id_pk" PRIMARY KEY("item_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."read_positions" (
	"item_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"position" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_positions_item_id_actor_type_actor_id_pk" PRIMARY KEY("item_id","actor_type","actor_id"),
	CONSTRAINT "read_positions_actor_type" CHECK ("app_artifacts"."read_positions"."actor_type" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."search" (
	"item_id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"title_tokens" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', title_tokens)) STORED NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."subscriptions" (
	"item_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "subscriptions_item_id_actor_type_actor_id_pk" PRIMARY KEY("item_id","actor_type","actor_id"),
	CONSTRAINT "subscriptions_actor_type" CHECK ("app_artifacts"."subscriptions"."actor_type" IN ('user', 'agent')),
	CONSTRAINT "subscriptions_reason" CHECK ("app_artifacts"."subscriptions"."reason" IN ('published', 'commented', 'followed'))
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."version_files" (
	"version_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"blob_id" text NOT NULL,
	CONSTRAINT "version_files_version_id_path_pk" PRIMARY KEY("version_id","path")
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."versions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"number" integer NOT NULL,
	"entry" text NOT NULL,
	"title" text,
	"description" text,
	"base_id" text,
	"label" text,
	"note" text,
	"spa" boolean DEFAULT false NOT NULL,
	"file_count" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"publish_digest" text NOT NULL,
	"provenance" jsonb,
	"status" text NOT NULL,
	"publisher_type" text NOT NULL,
	"publisher_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_type" text,
	"revoked_by_id" uuid,
	"position" bigint,
	CONSTRAINT "versions_publisher_type" CHECK ("app_artifacts"."versions"."publisher_type" IN ('user', 'agent')),
	CONSTRAINT "versions_revoked_by" CHECK (("app_artifacts"."versions"."revoked_by_type" IS NULL) = ("app_artifacts"."versions"."revoked_by_id" IS NULL) AND ("app_artifacts"."versions"."revoked_by_type" IS NULL OR "app_artifacts"."versions"."revoked_by_type" IN ('user', 'agent')))
);
--> statement-breakpoint
ALTER TABLE "object_event_recipients" ADD CONSTRAINT "object_event_recipients_event_id_object_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."object_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_events" ADD CONSTRAINT "object_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_events" ADD CONSTRAINT "object_events_home_channel_id_channels_id_fk" FOREIGN KEY ("home_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_inbox_states" ADD CONSTRAINT "object_inbox_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_inbox_states" ADD CONSTRAINT "object_inbox_states_home_channel_id_channels_id_fk" FOREIGN KEY ("home_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."attachment_saves" ADD CONSTRAINT "attachment_saves_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."attachment_saves" ADD CONSTRAINT "attachment_saves_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."attachment_saves" ADD CONSTRAINT "attachment_saves_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "app_artifacts"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."audit" ADD CONSTRAINT "audit_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."blobs" ADD CONSTRAINT "blobs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD CONSTRAINT "comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD CONSTRAINT "comments_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "app_artifacts"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_current_version_id_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "app_artifacts"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_home_channel_id_channels_id_fk" FOREIGN KEY ("home_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."pending_notices" ADD CONSTRAINT "pending_notices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."read_positions" ADD CONSTRAINT "read_positions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."search" ADD CONSTRAINT "search_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."search" ADD CONSTRAINT "search_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."subscriptions" ADD CONSTRAINT "subscriptions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_files" ADD CONSTRAINT "version_files_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "app_artifacts"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_files" ADD CONSTRAINT "version_files_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "app_artifacts"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."versions" ADD CONSTRAINT "versions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_object_event_recipients_recipient" ON "object_event_recipients" USING btree ("recipient_type","recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_object_events_seq" ON "object_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "idx_object_events_object_seq" ON "object_events" USING btree ("object_kind","object_id","seq");--> statement-breakpoint
CREATE INDEX "idx_object_events_server_seq" ON "object_events" USING btree ("server_id","seq");--> statement-breakpoint
CREATE INDEX "idx_object_events_created" ON "object_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_object_events_home_channel" ON "object_events" USING btree ("home_channel_id");--> statement-breakpoint
CREATE INDEX "idx_object_inbox_states_user_server_at" ON "object_inbox_states" USING btree ("user_id","server_id","last_event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_object_inbox_states_object" ON "object_inbox_states" USING btree ("object_kind","object_id");--> statement-breakpoint
CREATE INDEX "idx_object_inbox_states_last_event_at" ON "object_inbox_states" USING btree ("last_event_at");--> statement-breakpoint
CREATE INDEX "idx_object_inbox_states_home_channel" ON "object_inbox_states" USING btree ("home_channel_id");--> statement-breakpoint
CREATE INDEX "idx_object_inbox_states_server" ON "object_inbox_states" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_attachment_saves_item" ON "app_artifacts"."attachment_saves" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_audit_item_created" ON "app_artifacts"."audit" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_blobs_server_sha256" ON "app_artifacts"."blobs" USING btree ("server_id","sha256");--> statement-breakpoint
CREATE INDEX "idx_blobs_created" ON "app_artifacts"."blobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_comments_item_position" ON "app_artifacts"."comments" USING btree ("item_id","position");--> statement-breakpoint
CREATE INDEX "idx_comments_item_created" ON "app_artifacts"."comments" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_comments_mentions" ON "app_artifacts"."comments" USING gin ("mentions" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "idx_items_server_home" ON "app_artifacts"."items" USING btree ("server_id","home_kind");--> statement-breakpoint
CREATE INDEX "idx_items_home_channel" ON "app_artifacts"."items" USING btree ("home_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_items_live_name_conversation" ON "app_artifacts"."items" USING btree ("home_channel_id","name") WHERE "app_artifacts"."items"."home_kind" = 'conversation' AND "app_artifacts"."items"."deleted_at" IS NULL AND "app_artifacts"."items"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_items_live_name_server_home" ON "app_artifacts"."items" USING btree ("server_id","home_kind","name") WHERE "app_artifacts"."items"."home_kind" <> 'conversation' AND "app_artifacts"."items"."deleted_at" IS NULL AND "app_artifacts"."items"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_pending_notices_due" ON "app_artifacts"."pending_notices" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_read_positions_actor" ON "app_artifacts"."read_positions" USING btree ("actor_type","actor_id","item_id");--> statement-breakpoint
CREATE INDEX "idx_search_vector_gin" ON "app_artifacts"."search" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_actor" ON "app_artifacts"."subscriptions" USING btree ("actor_type","actor_id","item_id");--> statement-breakpoint
CREATE INDEX "idx_version_files_blob" ON "app_artifacts"."version_files" USING btree ("blob_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_versions_item_number" ON "app_artifacts"."versions" USING btree ("item_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_versions_item_position" ON "app_artifacts"."versions" USING btree ("item_id","position") WHERE "app_artifacts"."versions"."position" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_versions_publisher" ON "app_artifacts"."versions" USING btree ("publisher_type","publisher_id","item_id");