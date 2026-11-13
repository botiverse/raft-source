-- An Artifact's original conversation (#75, xxchan, Kirby and Remy,
-- docs/development/workspace-artifacts.md): `app_artifacts.items`
-- `original_home_channel_id`, the conversation it was published, saved or
-- imported into, set when it is made and never changed; the only
-- conversation a narrowing may return it to. Only app_artifacts tables, behind
-- workspace_artifacts_v0.
--
-- No foreign key to public.channels (Tenny: never from an app table to a hot
-- core table): adding one would lock channels until this transaction commits,
-- and core's channel deletes would depend on an app table. A deleted
-- conversation leaves the id dangling; readers then offer no narrowing.
--
-- Bounded lock wait: the column and the backfill lock app_artifacts.items
-- (one row per Artifact) briefly; give up after 5s (the deploy retries)
-- rather than queue its writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "original_home_channel_id" uuid;--> statement-breakpoint
-- Backfill, from app_artifacts alone: an Artifact homed in a conversation now
-- takes that conversation; any other (the whole server, public, or a
-- conversation hard-deleted since) the earliest conversation home its audit
-- rows record (every home change writes one in its transaction, `before`
-- { home_kind, home_channel_id }); none recorded: null (made in the whole
-- server, never in a conversation).
UPDATE "app_artifacts"."items" AS i
SET "original_home_channel_id" = COALESCE(
  CASE WHEN i."home_kind" = 'conversation' THEN i."home_channel_id" END,
  (
    SELECT (a."before" ->> 'home_channel_id')::uuid
    FROM "app_artifacts"."audit" AS a
    WHERE a."item_id" = i."id"
      AND a."before" ->> 'home_kind' = 'conversation'
      AND a."before" ->> 'home_channel_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ORDER BY a."created_at", a."id"
    LIMIT 1
  )
)
WHERE i."original_home_channel_id" IS NULL;
