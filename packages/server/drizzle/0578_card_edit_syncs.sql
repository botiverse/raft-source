-- Card messages (RFC 082 §4.6): a card update edits the message's bridged
-- Slack copy. `external_card_edit_syncs` holds, per original outbound delivery
-- (one message at one pair epoch), the latest revision to sync, written in the
-- card update's own transaction, and the sync's facts (the uncertain latch,
-- the latest definite result, what is pending, the lease that allows one edit
-- at a time). `external_card_edit_attempts` is the durable row each edit
-- attempt commits before its network call. `external_card_edit_pair_notices`
-- is the deduplicated per-pair notice to admins. Three new, empty tables: only
-- card updates (behind the `message_cards` flag, off for every Server with a
-- Slack bridge) and the edit worker write them; no backfill. Older server code
-- never names them, so rolling back leaves them unused. The exact-delivery
-- foreign key takes a SHARE ROW EXCLUSIVE lock on `external_outbound_deliveries`
-- (it blocks outbound queue writes while it is added): give up after 5 s rather
-- than queue Slack deliveries behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "external_card_edit_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sync_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"card_revision" integer NOT NULL,
	"lease_generation" bigint NOT NULL,
	"state" text DEFAULT 'sending' NOT NULL,
	"outcome_reason" text,
	"provider_io_started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_card_edit_attempt_shape" CHECK ("external_card_edit_attempts"."card_revision" >= 2 AND "external_card_edit_attempts"."lease_generation" > 0 AND "external_card_edit_attempts"."binding_epoch" > 0
      AND "external_card_edit_attempts"."state" IN ('sending', 'succeeded', 'failed', 'unknown')
      AND (("external_card_edit_attempts"."state" = 'sending' AND "external_card_edit_attempts"."completed_at" IS NULL AND "external_card_edit_attempts"."outcome_reason" IS NULL)
        OR ("external_card_edit_attempts"."state" <> 'sending' AND "external_card_edit_attempts"."completed_at" IS NOT NULL AND "external_card_edit_attempts"."outcome_reason" IS NOT NULL
          AND length(btrim("external_card_edit_attempts"."outcome_reason")) > 0 AND length("external_card_edit_attempts"."outcome_reason") <= 160)))
);
--> statement-breakpoint
CREATE TABLE "external_card_edit_pair_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"last_sync_id" uuid NOT NULL,
	"first_raised_at" timestamp with time zone NOT NULL,
	"last_raised_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_card_edit_pair_notice_valid" CHECK ("external_card_edit_pair_notices"."binding_epoch" > 0 AND length(btrim("external_card_edit_pair_notices"."binding_id")) > 0 AND length("external_card_edit_pair_notices"."binding_id") <= 160
      AND "external_card_edit_pair_notices"."kind" IN ('not_confirmed', 'latest_update_not_shown', 'updates_cannot_be_shown', 'edit_waiting')
      AND ("external_card_edit_pair_notices"."reason" IS NULL OR (length(btrim("external_card_edit_pair_notices"."reason")) > 0 AND length("external_card_edit_pair_notices"."reason") <= 160))
      AND "external_card_edit_pair_notices"."last_raised_at" >= "external_card_edit_pair_notices"."first_raised_at")
);
--> statement-breakpoint
CREATE TABLE "external_card_edit_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"latest_revision" integer NOT NULL,
	"shown_revision" integer,
	"succeeded_revision" integer,
	"refused_revision" integer,
	"refused_reason" text,
	"uncertain_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"end_reason" text,
	"hold_reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"quiet_until" timestamp with time zone,
	"readback_stage" smallint DEFAULT 0 NOT NULL,
	"readback_due_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"not_confirmed_since" timestamp with time zone,
	"notice_kind" text,
	"notice_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_card_edit_sync_revisions_valid" CHECK ("external_card_edit_syncs"."latest_revision" >= 2
      AND ("external_card_edit_syncs"."shown_revision" IS NULL OR ("external_card_edit_syncs"."shown_revision" >= 1 AND "external_card_edit_syncs"."shown_revision" <= "external_card_edit_syncs"."latest_revision"))
      AND ("external_card_edit_syncs"."succeeded_revision" IS NULL OR ("external_card_edit_syncs"."succeeded_revision" >= 2 AND "external_card_edit_syncs"."succeeded_revision" <= "external_card_edit_syncs"."latest_revision"))
      AND ("external_card_edit_syncs"."refused_revision" IS NULL OR ("external_card_edit_syncs"."refused_revision" >= 2 AND "external_card_edit_syncs"."refused_revision" <= "external_card_edit_syncs"."latest_revision"))
      AND (("external_card_edit_syncs"."refused_revision" IS NULL) = ("external_card_edit_syncs"."refused_reason" IS NULL))
      AND ("external_card_edit_syncs"."refused_reason" IS NULL OR (length(btrim("external_card_edit_syncs"."refused_reason")) > 0 AND length("external_card_edit_syncs"."refused_reason") <= 160))
      AND ("external_card_edit_syncs"."hold_reason" IS NULL OR (length(btrim("external_card_edit_syncs"."hold_reason")) > 0 AND length("external_card_edit_syncs"."hold_reason") <= 160))
      AND "external_card_edit_syncs"."retry_count" >= 0 AND "external_card_edit_syncs"."lease_generation" >= 0 AND "external_card_edit_syncs"."binding_epoch" > 0
      AND length(btrim("external_card_edit_syncs"."binding_id")) > 0 AND length("external_card_edit_syncs"."binding_id") <= 160),
	CONSTRAINT "external_card_edit_sync_state_shape" CHECK ((("external_card_edit_syncs"."state" = 'open' AND "external_card_edit_syncs"."end_reason" IS NULL) OR ("external_card_edit_syncs"."state" = 'ended' AND "external_card_edit_syncs"."end_reason" IS NOT NULL))
      AND (("external_card_edit_syncs"."lease_owner" IS NULL AND "external_card_edit_syncs"."lease_expires_at" IS NULL)
        OR ("external_card_edit_syncs"."state" = 'open' AND "external_card_edit_syncs"."lease_owner" IS NOT NULL AND length(btrim("external_card_edit_syncs"."lease_owner")) > 0
          AND length("external_card_edit_syncs"."lease_owner") <= 160 AND "external_card_edit_syncs"."lease_expires_at" IS NOT NULL AND "external_card_edit_syncs"."lease_generation" > 0))
      AND "external_card_edit_syncs"."readback_stage" IN (0, 1, 2)
      AND (("external_card_edit_syncs"."readback_stage" = 0) = ("external_card_edit_syncs"."readback_due_at" IS NULL))
      AND (("external_card_edit_syncs"."notice_kind" IS NULL) = ("external_card_edit_syncs"."notice_at" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "external_card_edit_attempts" ADD CONSTRAINT "external_card_edit_attempts_sync_id_external_card_edit_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."external_card_edit_syncs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_card_edit_syncs" ADD CONSTRAINT "external_card_edit_syncs_exact_delivery_fk" FOREIGN KEY ("delivery_id","binding_id","binding_epoch","source_message_id") REFERENCES "public"."external_outbound_deliveries"("id","binding_id","binding_epoch","source_message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_card_edit_attempt_lease" ON "external_card_edit_attempts" USING btree ("sync_id","lease_generation");--> statement-breakpoint
CREATE INDEX "idx_external_card_edit_attempt_state" ON "external_card_edit_attempts" USING btree ("state","provider_io_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_card_edit_pair_notice" ON "external_card_edit_pair_notices" USING btree ("binding_id","binding_epoch","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_card_edit_sync_delivery" ON "external_card_edit_syncs" USING btree ("delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_card_edit_sync_source_epoch" ON "external_card_edit_syncs" USING btree ("source_message_id","binding_id","binding_epoch");--> statement-breakpoint
CREATE INDEX "idx_external_card_edit_sync_due" ON "external_card_edit_syncs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_external_card_edit_sync_lease" ON "external_card_edit_syncs" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_external_card_edit_sync_not_confirmed" ON "external_card_edit_syncs" USING btree ("state","not_confirmed_since");