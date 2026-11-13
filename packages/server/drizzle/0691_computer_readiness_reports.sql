-- #proj-raft-computer:#68 (readiness PR 1): the latest `machine:runtime_readiness`
-- report per Computer (db/schema.ts computerReadinessReports): the facts only
-- its daemon observes, without text, paths or accounts. The runtime-auth KV
-- has a TTL, so the facts live here until the daemon reports them gone.
-- `notified`: when each (login key, code) was last told to its owner.
--
-- A new, empty table: nothing is scanned or rewritten. The foreign key to
-- "daemons" takes a SHARE ROW EXCLUSIVE lock on it for the ADD CONSTRAINT
-- only, so give up after 2 s (the deploy retries) rather than queue machine
-- reads behind a long transaction. Rolling deploy: an older replica never
-- reads or writes this table.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "computer_readiness_reports" (
	"daemon_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"facts" jsonb NOT NULL,
	"notified" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computer_readiness_reports" ADD CONSTRAINT "computer_readiness_reports_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;
