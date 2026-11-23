-- Data export jobs (services/dataExport/, docs/development/data-export.md;
-- #triage:#512 design v7):
--   data_exports             one row per export a person asked for: kind
--                            (personal | server), requester and the sign-in
--                            that asked, scope, status (queued, running,
--                            ready, failed, expired, deleted), the durable
--                            task that writes it, its progress and finished
--                            volumes, and when it was asked, started,
--                            finished, expires and was downloaded. At most one
--                            in flight per person and per server (server
--                            kind): partial unique indexes.
--   auth_challenges.kind     + data_export_email_code: the emailed code that
--                            confirms a data export for a person with neither
--                            a password nor two-step verification
--                            (services/accountDeletion/emailCode.ts). Its own
--                            kind, so an account deletion code never confirms
--                            an export and the reverse.
--
-- The new table is empty: its constraints and indexes are instant; its
-- foreign keys to users and servers take a short SHARE ROW EXCLUSIVE lock on
-- each, no scan. The kind CHECK is swapped last, as 0719 swaps one: DROP and
-- ADD ... NOT VALID side by side at the end, so auth_challenges' ACCESS
-- EXCLUSIVE lock is taken only for those two catalog changes and the commit,
-- with no scan of the table. It stays NOT VALID, with no VALIDATE: the new
-- list is a superset of the old one, which every existing row already passed,
-- and every write from now on is checked. Rows written by the previous release
-- pass it, and that release never writes the new kind.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_session_family_id" uuid NOT NULL,
	"server_id" uuid,
	"scope" jsonb NOT NULL,
	"scope_version" integer NOT NULL,
	"status" text NOT NULL,
	"durable_task_id" bigint,
	"progress" jsonb,
	"volumes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"size_bytes" bigint,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"last_downloaded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "data_exports_kind_valid" CHECK ("data_exports"."kind" IN ('personal', 'server')),
	CONSTRAINT "data_exports_status_valid" CHECK ("data_exports"."status" IN ('queued', 'running', 'ready', 'failed', 'expired', 'deleted')),
	CONSTRAINT "data_exports_server_kind" CHECK (("data_exports"."kind" = 'server') = ("data_exports"."server_id" IS NOT NULL)),
	CONSTRAINT "data_exports_ready_expires" CHECK ("data_exports"."status" <> 'ready' OR ("data_exports"."expires_at" IS NOT NULL AND "data_exports"."finished_at" IS NOT NULL)),
	CONSTRAINT "data_exports_deleted_at" CHECK (("data_exports"."status" = 'deleted') = ("data_exports"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_data_exports_requester_in_flight" ON "data_exports" USING btree ("requester_user_id") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_data_exports_server_in_flight" ON "data_exports" USING btree ("server_id") WHERE kind = 'server' AND status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_data_exports_requester_created" ON "data_exports" USING btree ("requester_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_data_exports_server_created" ON "data_exports" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_data_exports_ready_expires" ON "data_exports" USING btree ("expires_at") WHERE status = 'ready';--> statement-breakpoint
CREATE INDEX "idx_data_exports_in_flight_updated" ON "data_exports" USING btree ("updated_at") WHERE status IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "auth_challenges" DROP CONSTRAINT "auth_challenges_kind_check";--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_kind_check" CHECK ("auth_challenges"."kind" IN ('webauthn_registration', 'webauthn_assertion', 'second_factor_login', 'account_deletion_email_code', 'data_export_email_code')) NOT VALID;