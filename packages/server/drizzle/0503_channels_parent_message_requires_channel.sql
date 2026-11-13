-- Parent-message cache invariant, phase 1: catalog-only, no historical scan.
-- Existing BEFORE INSERT/UPDATE triggers derive the cache and message moves
-- update it in the same transaction (including soft-deleted threads).
-- Deploy runs each migration in its own transaction; the following validation
-- phase must finish before the new cached-only family reader starts.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_parent_message_requires_channel" CHECK ("channels"."parent_message_id" IS NULL OR "channels"."parent_channel_id" IS NOT NULL) NOT VALID;
