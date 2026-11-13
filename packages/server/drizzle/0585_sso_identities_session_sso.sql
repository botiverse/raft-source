-- SSO v1 sign-in (rfcs/083-server-sso.md §4, §5.4): `sso_identities` (a
-- person as a Server's IdP knows them, by the IdP's subject under one
-- connection) and, on `session_families`, the connection that signed a family
-- in and when. Nullable columns with no default and no backfill (families
-- from before were not signed in by SSO): a catalog-only change, one ALTER so
-- the lock on the hot `session_families` is taken once, as the last
-- statement so it is held only until commit. Older server code
-- never names them. Give up after 5 s rather than queue sign-ins and
-- refreshes behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email_at_link" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_connection_id_server_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."server_sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sso_identities_connection_subject" ON "sso_identities" USING btree ("connection_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sso_identities_connection_user" ON "sso_identities" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_sso_identities_user" ON "sso_identities" USING btree ("user_id");--> statement-breakpoint
-- Last, so the exclusive lock on the hot table is held only to commit.
ALTER TABLE "session_families"
	ADD COLUMN "sso_connection_id" uuid,
	ADD COLUMN "sso_authenticated_at" timestamp with time zone;
