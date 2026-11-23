-- Computer pairings (design "one-click Computer login" §11 B,
-- docs/contracts/computer-pairing.md): the Add Computer window's one-time
-- pairing, so the device authorization a Computer starts with `--pair <id>`
-- can be shown and approved in that window. Additive: a new, empty table.
--   pairing_hash                 sha256 (hex) of the raw id; the raw id is
--                                never stored.
--   user_id, server_id           whose window, for which server.
--   session_family_id            the sign-in that created it: the only one
--                                that may use it; revoking it voids it.
--   expires_at                   10 minutes, renewed while the window is open.
--   linked_device_authorization_id, conflict_at, voided_at + void_reason,
--   consumed_at                  the link (compare-and-swap), a second
--                                request (voids it), cancel / sign-out, and
--                                an approve or deny through it.
--
-- Locks: CREATE TABLE takes nothing on other tables; each foreign key takes
-- SHARE ROW EXCLUSIVE on the table it references (users, servers,
-- session_families, device_authorizations) for the moment it validates an
-- empty table. 2 s lock wait, then the deploy retries.
-- Rolling deploy: an older replica never reads or writes the table; a
-- Computer that sends pairingId to it is answered as a normal device login.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "computer_pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pairing_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"session_family_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"linked_device_authorization_id" uuid,
	"conflict_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "computer_pairings_pairing_hash_unique" UNIQUE("pairing_hash"),
	CONSTRAINT "computer_pairings_void_reason_valid" CHECK (("computer_pairings"."voided_at" IS NULL AND "computer_pairings"."void_reason" IS NULL) OR ("computer_pairings"."voided_at" IS NOT NULL AND "computer_pairings"."void_reason" IN ('cancelled', 'conflict', 'signed_out')))
);
--> statement-breakpoint
ALTER TABLE "computer_pairings" ADD CONSTRAINT "computer_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_pairings" ADD CONSTRAINT "computer_pairings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_pairings" ADD CONSTRAINT "computer_pairings_session_family_id_session_families_id_fk" FOREIGN KEY ("session_family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_pairings" ADD CONSTRAINT "computer_pairings_linked_device_authorization_id_device_authorizations_id_fk" FOREIGN KEY ("linked_device_authorization_id") REFERENCES "public"."device_authorizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_pairings_user" ON "computer_pairings" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_computer_pairings_server" ON "computer_pairings" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_computer_pairings_session_family" ON "computer_pairings" USING btree ("session_family_id");--> statement-breakpoint
CREATE INDEX "idx_computer_pairings_linked_authorization" ON "computer_pairings" USING btree ("linked_device_authorization_id");