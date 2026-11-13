-- Card messages (RFC 082 §4.5): `message_card_revisions`, every version of a
-- message card (revision 1 at send; each update adds one), going with its
-- message and its sending agent (ON DELETE CASCADE), and the `message_cards`
-- flag row. A new, empty table behind a new flag that is off, with no rules;
-- no backfill (only sends after the flag is on write a revision). Older server
-- code never names it, so rolling back leaves it unused. The foreign keys take
-- a SHARE ROW EXCLUSIVE lock on `messages` and `agents`: give up after 2 s
-- rather than queue sends behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
-- Server-scoped, default off, no rules: while off, a send with a card is refused.
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
	'message_cards',
	'Card messages (RFC 082): agents and App bots post a message with a display-only card',
	true,
	false,
	'server',
	false,
	NULL,
	'message_cards'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE TABLE "message_card_revisions" (
	"message_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"card" jsonb NOT NULL,
	"content" text NOT NULL,
	"sender_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_card_revisions_message_id_revision_pk" PRIMARY KEY("message_id","revision"),
	CONSTRAINT "message_card_revisions_revision_positive" CHECK ("message_card_revisions"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "message_card_revisions" ADD CONSTRAINT "message_card_revisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_card_revisions" ADD CONSTRAINT "message_card_revisions_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_card_revisions_created_at" ON "message_card_revisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_message_card_revisions_sender_agent" ON "message_card_revisions" USING btree ("sender_agent_id");