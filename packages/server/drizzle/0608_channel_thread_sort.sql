-- Forum-style channels (#proj-chat:#24): channels.thread_sort orders a
-- regular channel's top-level messages, 'time' (post order, the default) or
-- 'activity' (latest activity: own time or latest thread reply). A constant
-- default makes the ADD COLUMN catalog-only (no table rewrite). Give up after
-- 2 s rather than queue channel reads behind a long transaction on channels
-- (the deploy runner retries), like the other recent hot-table migrations.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "thread_sort" text DEFAULT 'time' NOT NULL;--> statement-breakpoint
-- change_log: the channels update trigger logs only the columns in its WHEN
-- list; add thread_sort so sync-changes clients see the setting change. Same
-- list as change_log, plus thread_sort.
DROP TRIGGER IF EXISTS change_log_channels_upd ON public.channels;--> statement-breakpoint
CREATE TRIGGER change_log_channels_upd AFTER UPDATE ON public.channels
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.guest_visible IS DISTINCT FROM NEW.guest_visible
    OR OLD.guest_joinable IS DISTINCT FROM NEW.guest_joinable OR OLD.parent_channel_id IS DISTINCT FROM NEW.parent_channel_id
    OR OLD.parent_message_id IS DISTINCT FROM NEW.parent_message_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.server_id IS DISTINCT FROM NEW.server_id OR OLD.thread_sort IS DISTINCT FROM NEW.thread_sort)
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
	'channel_thread_sort_v0',
	'Forum-style channels: a channel option that orders top-level messages by latest activity (own time or latest thread reply)',
	true,
	false,
	'server',
	false,
	NULL,
	'channel_thread_sort_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
