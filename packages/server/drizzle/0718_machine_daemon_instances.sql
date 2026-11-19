-- The daemon instance each machine last connected with (db/schema.ts
-- machineDaemonInstances), so a `ready` tells a restarted or upgraded daemon
-- (new `daemonInstanceId`) from a plain socket reconnect of the same one, on
-- any replica and across server restarts. On a change, the server re-sends the
-- machine's agents' app events still `delivering` from before the new daemon
-- connected (thirdPartyAgentEventRedelivery, trigger daemon_instance_changed).
--
-- A new, empty table: nothing is scanned or rewritten. The foreign key to
-- "daemons" takes a SHARE ROW EXCLUSIVE lock on it for the ADD CONSTRAINT
-- only, so give up after 2 s (the deploy retries) rather than queue machine
-- reads behind a long transaction. Rolling deploy: an older replica never
-- reads or writes this table.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "machine_daemon_instances" (
	"daemon_id" uuid PRIMARY KEY NOT NULL,
	"daemon_instance_id" text NOT NULL,
	"previous_daemon_instance_id" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_daemon_instances" ADD CONSTRAINT "machine_daemon_instances_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;