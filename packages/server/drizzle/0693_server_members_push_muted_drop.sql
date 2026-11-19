-- Unified notifications, contract step 2, split out of
-- notification_outbox_fk_indexes / notification_outbox_legacy_columns_drop.
-- RisingWave: server_members is replicated as rw_server_members (managed
-- outside this repo). Its live catalog on prod (RW 3.1.0) and staging
-- (3.0.3), read back 2026-11-09, has no server_push_muted column and the
-- source has auto.schema.change = false, so this upstream drop needs no
-- RisingWave change first.
--
-- This one: server_members drops the legacy
-- server_push_muted boolean and the trigger that kept it in step with
-- server_push_mode for older binaries (migration brave_dragon_lord). The
-- release carrying step 1 already writes and reads only server_push_mode;
-- routes answer serverPushMuted / serverPushMentionsOnly derived from it.
--
-- notification_prefs_version stays: the step 1 release still reads it
-- (GREATEST with user_notification_level_versions). A later release stops
-- reading it, and the one after that drops it.
--
-- schema-snapshot: unchanged (step 1 already removed server_push_muted from
-- schema.ts; the trigger and function were never declared there)
--
-- The trigger and function go first (the trigger names the column); all
-- three are catalog-only, under one ACCESS EXCLUSIVE lock on server_members
-- taken up front, whose wait lock_timeout bounds. An object that is already
-- gone is named in a NOTICE, never skipped silently.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "server_members" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.server_members'::regclass AND tgname = 'server_members_push_mode_sync') THEN
    DROP TRIGGER "server_members_push_mode_sync" ON "server_members";
  ELSE
    RAISE NOTICE 'server_members_push_muted_drop: trigger server_members_push_mode_sync does not exist; nothing to drop';
  END IF;
  IF to_regprocedure('public.sync_server_member_push_mode()') IS NOT NULL THEN
    DROP FUNCTION "sync_server_member_push_mode"();
  ELSE
    RAISE NOTICE 'server_members_push_muted_drop: function sync_server_member_push_mode() does not exist; nothing to drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.server_members'::regclass AND attname = 'server_push_muted' AND attnum > 0 AND NOT attisdropped
  ) THEN
    ALTER TABLE "server_members" DROP COLUMN "server_push_muted";
  ELSE
    RAISE NOTICE 'server_members_push_muted_drop: server_members.server_push_muted does not exist; nothing to drop';
  END IF;
END
$$;
