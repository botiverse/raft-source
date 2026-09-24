-- Freeze migration creation/completion while the v2 receipt contract is
-- installed. NOWAIT fails closed instead of queueing behind live traffic, and
-- the zero-active check prevents stranding an in-flight v1 migration without
-- its dedicated receipt surface.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
LOCK TABLE "agent_migrations" IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "agent_migrations"
		WHERE "state" IN ('provisioning', 'prep', 'ready', 'in_transit', 'arriving', 'starting', 'cancel_requested_pre_flip', 'cancel_requested_post_flip')
	) THEN
		RAISE EXCEPTION 'agent migration receipt expansion requires zero active migrations';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "agent_migration_receipt_channels" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"migration_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_migration_receipt_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"migration_id" uuid NOT NULL,
	"receipt_kind" text NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_migration_receipt_outbox_kind_check" CHECK ("agent_migration_receipt_outbox"."receipt_kind" IN ('completed')),
	CONSTRAINT "agent_migration_receipt_outbox_status_check" CHECK ("agent_migration_receipt_outbox"."status" IN ('pending', 'processing', 'sent'))
);
--> statement-breakpoint
ALTER TABLE "agent_migrations" ALTER COLUMN "support_ref" SET DEFAULT 'mig_' || translate(rtrim(encode(uuid_send(gen_random_uuid()), 'base64'), '='), '+/', '-_');--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "source_machine_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "target_machine_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "receipt_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "contract_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transfer_summary" jsonb;--> statement-breakpoint
UPDATE "agent_migrations" AS migration
SET
	"source_machine_name_snapshot" = COALESCE(
		(SELECT "name" FROM "daemons" WHERE "id" = migration."source_machine_id"),
		'Computer'
	),
	"target_machine_name_snapshot" = COALESCE(
		(SELECT "name" FROM "daemons" WHERE "id" = migration."target_machine_id"),
		'Computer'
	),
	"contract_version" = 2;--> statement-breakpoint
ALTER TABLE "agent_migrations" ALTER COLUMN "source_machine_name_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ALTER COLUMN "target_machine_name_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_channels" ADD CONSTRAINT "agent_migration_receipt_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_channels" ADD CONSTRAINT "agent_migration_receipt_channels_migration_id_agent_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."agent_migrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_channels" ADD CONSTRAINT "agent_migration_receipt_channels_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_channels" ADD CONSTRAINT "agent_migration_receipt_channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_migration_id_agent_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."agent_migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migration_receipt_outbox" ADD CONSTRAINT "agent_migration_receipt_outbox_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migration_receipt_channels_migration" ON "agent_migration_receipt_channels" USING btree ("migration_id");--> statement-breakpoint
CREATE INDEX "idx_agent_migration_receipt_channels_agent" ON "agent_migration_receipt_channels" USING btree ("agent_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migration_receipt_outbox_dedupe" ON "agent_migration_receipt_outbox" USING btree ("migration_id","receipt_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migration_receipt_outbox_message" ON "agent_migration_receipt_outbox" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_agent_migration_receipt_outbox_pending" ON "agent_migration_receipt_outbox" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_receipt_channel_id_channels_id_fk" FOREIGN KEY ("receipt_channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_contract_version_check" CHECK ("agent_migrations"."contract_version" >= 1);--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_receipt_contract_version_check" CHECK ("agent_migrations"."contract_version" >= 2);--> statement-breakpoint

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
BEGIN
	SELECT * INTO channel_row FROM "channels" WHERE "id" = NEW."channel_id";
	SELECT * INTO migration_row FROM "agent_migrations" WHERE "id" = NEW."migration_id";
	SELECT count(*)::integer INTO agent_count FROM "channel_agents" WHERE "channel_id" = NEW."channel_id";
	SELECT count(*)::integer INTO exact_agent_count FROM "channel_agents" WHERE "channel_id" = NEW."channel_id" AND "agent_id" = NEW."agent_id";
	SELECT count(*)::integer INTO human_count FROM "channel_humans" WHERE "channel_id" = NEW."channel_id";
	IF channel_row."id" IS NULL
		OR channel_row."server_id" <> NEW."server_id"
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
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_channel_validate"
BEFORE INSERT ON "agent_migration_receipt_channels"
FOR EACH ROW EXECUTE FUNCTION "validate_agent_migration_receipt_channel"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_agent_migration_receipt_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'agent migration receipt channel identity is immutable';
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_identity_immutable"
BEFORE UPDATE OR DELETE ON "agent_migration_receipt_channels"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_migration_receipt_identity_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_agent_migration_receipt_membership_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (
		TG_OP <> 'DELETE'
		AND EXISTS (
			SELECT 1 FROM "agent_migration_receipt_channels"
			WHERE "channel_id" = NEW."channel_id"
		)
	) OR (
		TG_OP <> 'INSERT'
		AND EXISTS (
			SELECT 1 FROM "agent_migration_receipt_channels"
			WHERE "channel_id" = OLD."channel_id"
		)
	) THEN
		RAISE EXCEPTION 'agent migration receipt channel membership is immutable';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_agent_membership_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "channel_agents"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_migration_receipt_membership_mutation"();--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_human_membership_forbidden"
BEFORE INSERT OR UPDATE OR DELETE ON "channel_humans"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_migration_receipt_membership_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_agent_migration_receipt_channel_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "agent_migration_receipt_channels" WHERE "channel_id" = OLD."id") THEN
		RAISE EXCEPTION 'agent migration receipt channel is immutable';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_channel_immutable"
BEFORE UPDATE OR DELETE ON "channels"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_migration_receipt_channel_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_agent_migration_receipt_message_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "agent_migration_receipt_outbox" WHERE "message_id" = OLD."id") THEN
		RAISE EXCEPTION 'agent migration receipt message is immutable';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_message_immutable"
BEFORE UPDATE OR DELETE ON "messages"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_migration_receipt_message_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "validate_agent_migration_receipt_outbox"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."receipt_kind" <> 'completed' OR NOT EXISTS (
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
			AND migration."state" = 'completed'
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
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_outbox_validate"
BEFORE INSERT ON "agent_migration_receipt_outbox"
FOR EACH ROW EXECUTE FUNCTION "validate_agent_migration_receipt_outbox"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_agent_migration_receipt_outbox_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE'
		OR OLD."id" IS DISTINCT FROM NEW."id"
		OR OLD."migration_id" IS DISTINCT FROM NEW."migration_id"
		OR OLD."receipt_kind" IS DISTINCT FROM NEW."receipt_kind"
		OR OLD."server_id" IS DISTINCT FROM NEW."server_id"
		OR OLD."agent_id" IS DISTINCT FROM NEW."agent_id"
		OR OLD."channel_id" IS DISTINCT FROM NEW."channel_id"
		OR OLD."message_id" IS DISTINCT FROM NEW."message_id"
		OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
	THEN
		RAISE EXCEPTION 'agent migration receipt outbox identity is immutable';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_migration_receipt_outbox_identity_immutable"
BEFORE UPDATE OR DELETE ON "agent_migration_receipt_outbox"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_migration_receipt_outbox_identity_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "require_agent_migration_completed_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."state" = 'completed' AND NOT EXISTS (
		SELECT 1
		FROM "agent_migration_receipt_outbox" outbox
		JOIN "agent_migration_receipt_channels" surface
			ON surface."channel_id" = outbox."channel_id"
			AND surface."migration_id" = outbox."migration_id"
			AND surface."agent_id" = outbox."agent_id"
		WHERE outbox."migration_id" = NEW."id"
			AND outbox."receipt_kind" = 'completed'
			AND outbox."server_id" = NEW."server_id"
			AND outbox."agent_id" = NEW."agent_id"
			AND outbox."channel_id" = NEW."receipt_channel_id"
	) THEN
		RAISE EXCEPTION 'completed agent migration requires durable receipt';
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_migration_completed_receipt_required"
AFTER INSERT OR UPDATE OF "state" ON "agent_migrations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_agent_migration_completed_receipt"();
