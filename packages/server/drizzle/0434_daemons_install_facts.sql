-- daemons.install_kind / node_on_path from the daemon's `ready`. Both columns
-- are nullable with no default (metadata-only), but ADD COLUMN still takes an
-- ACCESS EXCLUSIVE lock, and `daemons` is written on every heartbeat: give up
-- after 5 s rather than queue every heartbeat behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "install_kind" text;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "node_on_path" boolean;
