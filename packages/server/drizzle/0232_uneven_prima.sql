ALTER TABLE "agent_migration_receipt_outbox" DROP CONSTRAINT "agent_migration_receipt_outbox_kind_check";--> statement-breakpoint
DROP INDEX "idx_agent_migrations_active_agent";--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_cleanup_lease_id" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_cleanup_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migrations_active_agent" ON "agent_migrations" USING btree ("agent_id") WHERE "agent_migrations"."state" IN ('provisioning', 'prep', 'ready', 'in_transit', 'arriving', 'starting');--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_kind_check" CHECK ("agent_migration_receipt_outbox"."receipt_kind" IN ('completed', 'canceled', 'failed'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_agent_migration_receipt_channel"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	channel_row "channels"%ROWTYPE;
	migration_row "agent_migrations"%ROWTYPE;
	agent_count integer;
	exact_agent_count integer;
	human_count integer;
	channel_in_receipt_server boolean;
BEGIN
	SELECT * INTO channel_row FROM "channels" WHERE "id" = NEW."channel_id";
	SELECT * INTO migration_row FROM "agent_migrations" WHERE "id" = NEW."migration_id";
	SELECT count(*)::integer INTO agent_count FROM "channel_agents" WHERE "channel_id" = NEW."channel_id";
	SELECT count(*)::integer INTO exact_agent_count FROM "channel_agents" WHERE "channel_id" = NEW."channel_id" AND "agent_id" = NEW."agent_id";
	SELECT count(*)::integer INTO human_count FROM "channel_humans" WHERE "channel_id" = NEW."channel_id";
	channel_in_receipt_server := channel_row."server_id" = NEW."server_id" OR EXISTS (
		SELECT 1
		FROM "joint_channel_servers" projection
		JOIN "joint_channels" joint_storage
			ON joint_storage."id" = projection."joint_channel_id"
		WHERE projection."local_channel_id" = NEW."channel_id"
			AND projection."server_id" = NEW."server_id"
			AND projection."status" = 'active'
			AND joint_storage."status" = 'active'
	);
	IF channel_row."id" IS NULL
		OR NOT channel_in_receipt_server
		OR channel_row."type" <> 'dm'
		OR channel_row."deleted_at" IS NOT NULL
		OR migration_row."id" IS NULL
		OR migration_row."server_id" <> NEW."server_id"
		OR migration_row."agent_id" <> NEW."agent_id"
		OR migration_row."receipt_channel_id" <> NEW."channel_id"
		OR agent_count <> 1
		OR exact_agent_count <> 1
		OR human_count <> 0
	THEN
		RAISE EXCEPTION 'agent migration receipt channel audience is invalid';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_agent_migration_receipt_outbox"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "agent_migrations" migration
		JOIN "agent_migration_receipt_channels" surface
			ON surface."migration_id" = migration."id"
			AND surface."server_id" = migration."server_id"
			AND surface."agent_id" = migration."agent_id"
			AND surface."channel_id" = migration."receipt_channel_id"
		JOIN "messages" message
			ON message."id" = NEW."message_id"
			AND message."channel_id" = surface."channel_id"
		WHERE migration."id" = NEW."migration_id"
			AND (
				(NEW."receipt_kind" = 'completed' AND migration."state" = 'completed')
				OR (NEW."receipt_kind" = 'canceled' AND migration."state" IN ('canceled_pre_flip', 'canceled_post_flip'))
				OR (NEW."receipt_kind" = 'failed' AND migration."state" = 'failed')
			)
			AND migration."server_id" = NEW."server_id"
			AND migration."agent_id" = NEW."agent_id"
			AND migration."receipt_channel_id" = NEW."channel_id"
			AND surface."server_id" = NEW."server_id"
			AND surface."agent_id" = NEW."agent_id"
			AND surface."channel_id" = NEW."channel_id"
			AND message."sender_type" = 'user'
			AND message."sender_id" = 'system'
			AND message."message_type" = 'system'
	) THEN
		RAISE EXCEPTION 'agent migration receipt outbox identity is invalid';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "require_agent_migration_completed_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	expected_kind text;
BEGIN
	expected_kind := CASE
		WHEN NEW."state" = 'completed' THEN 'completed'
		WHEN NEW."state" IN ('canceled_pre_flip', 'canceled_post_flip') THEN 'canceled'
		WHEN NEW."state" = 'failed' THEN 'failed'
		ELSE NULL
	END;
	IF expected_kind IS NOT NULL AND NOT EXISTS (
		SELECT 1
		FROM "agent_migration_receipt_outbox" outbox
		JOIN "agent_migration_receipt_channels" surface
			ON surface."channel_id" = outbox."channel_id"
			AND surface."migration_id" = outbox."migration_id"
			AND surface."agent_id" = outbox."agent_id"
		WHERE outbox."migration_id" = NEW."id"
			AND outbox."receipt_kind" = expected_kind
			AND outbox."server_id" = NEW."server_id"
			AND outbox."agent_id" = NEW."agent_id"
			AND outbox."channel_id" = NEW."receipt_channel_id"
	) THEN
		RAISE EXCEPTION 'terminal agent migration requires durable receipt';
	END IF;
	RETURN NULL;
END $$;
