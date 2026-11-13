-- Channel announcements (#proj-chat:#29, flag channel_announcement_v0).
--
-- 1. channels.announcement_artifact_id: the id (`pt_…`) of the Artifact a
--    channel has as its announcement, NULL for none. Nullable with no
--    default, so the ADD COLUMN is catalog-only (no table rewrite, no scan).
--    No foreign key and no CHECK: never from a hot core table to an app's
--    table, and an id whose Artifact went away reads as none (the server
--    resolves it on read).
-- 2. channel_announcement_hides: a person's "hide until the next update" of a
--    channel's announcement, one row per (person, channel). New and empty:
--    its foreign keys to users and channels take a SHARE ROW EXCLUSIVE lock
--    on those tables for the catalog change only (nothing to validate), in
--    the same short transaction as the catalog-only column.
-- 3. change_log_channels_upd re-created with the new column, and the flag.
--
-- Give up after 2 s rather than queue reads behind a long transaction on
-- channels or users (the deploy runner retries), like the other recent
-- hot-table migrations.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "channel_announcement_hides" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"hidden_until_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_announcement_hides_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "announcement_artifact_id" text;--> statement-breakpoint
ALTER TABLE "channel_announcement_hides" ADD CONSTRAINT "channel_announcement_hides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_announcement_hides" ADD CONSTRAINT "channel_announcement_hides_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_announcement_hides_channel" ON "channel_announcement_hides" USING btree ("channel_id");--> statement-breakpoint
-- change_log: the channels update trigger logs only the columns in its WHEN
-- list; add announcement_artifact_id so sync-changes clients refetch a
-- channel whose announcement changed. Same list as the last definition
-- (channel_thread_sort), plus announcement_artifact_id. guest_joinable stays
-- in it until the release that drops that column recreates this trigger
-- without it (see guest_join_checks_drop).
DROP TRIGGER IF EXISTS change_log_channels_upd ON public.channels;--> statement-breakpoint
CREATE TRIGGER change_log_channels_upd AFTER UPDATE ON public.channels
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.guest_visible IS DISTINCT FROM NEW.guest_visible
    OR OLD.guest_joinable IS DISTINCT FROM NEW.guest_joinable OR OLD.parent_channel_id IS DISTINCT FROM NEW.parent_channel_id
    OR OLD.parent_message_id IS DISTINCT FROM NEW.parent_message_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.server_id IS DISTINCT FROM NEW.server_id OR OLD.thread_sort IS DISTINCT FROM NEW.thread_sort
    OR OLD.announcement_artifact_id IS DISTINCT FROM NEW.announcement_artifact_id)
  EXECUTE FUNCTION public.change_log_channels_fn();--> statement-breakpoint
-- The flag: server-scoped, default off, no rules (off everywhere until a
-- server rule is added through the feature-flag admin worker).
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt",
	"pre_auth_evaluable"
) VALUES (
	'channel_announcement_v0',
	'Channel announcements: a channel''s owner or a server owner or admin sets one Artifact homed in the channel as its announcement',
	true,
	false,
	'server',
	false,
	NULL,
	'channel_announcement_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
