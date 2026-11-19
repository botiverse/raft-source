-- RFC 086 step 2 (PR C).
--
-- oauth_app_card_encryption_kids: every kid an App has set a card encryption
-- key under, so a new key under any kid the App used before is refused (409
-- KID_IN_USE), not only under the one in force (Tenny). Per App, not on the
-- registration row: it outlives a deleted or taken-over registration. Not
-- backfilled: keys came with 0709, which no release carries yet, so no
-- production App has set one; on staging the key in force stays covered (the
-- service also refuses another key under the kid in force), and only a kid
-- rotated away before this deploy is not remembered.
--
-- link_card_operations: two flags saying an execute carried a card form's
-- values (sealed SecretInput values, TextInput values). The values themselves
-- are never stored.
--
-- Additive, catalog changes only: a new empty table, two columns with
-- constant defaults (no table rewrite); older servers ignore both. Locks:
-- ACCESS EXCLUSIVE on link_card_operations for the catalog change, SHARE ROW
-- EXCLUSIVE on oauth_clients for the foreign key: wait at most 2 s.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "oauth_app_card_encryption_kids" (
	"client_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"first_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_app_card_encryption_kids_client_id_kid_pk" PRIMARY KEY("client_id","kid")
);
--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD COLUMN "sealed_inputs_submitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD COLUMN "text_inputs_submitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_app_card_encryption_kids" ADD CONSTRAINT "oauth_app_card_encryption_kids_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
