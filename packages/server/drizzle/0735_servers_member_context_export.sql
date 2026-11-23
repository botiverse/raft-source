-- Data export (#triage:#512 design §4 "Owner 的开关", docs/development/data-export.md):
-- servers.member_context_export_enabled, the owner's switch "Allow members to export this
-- server's context". When on, a member's personal export may include the other people's messages
-- of the conversations they see in this server (inside the plan's history window). Off by
-- default, so every existing server allows no context, as before.
--
-- A constant non-volatile default with NOT NULL: catalog only since Postgres 11, no rewrite.
-- ACCESS EXCLUSIVE on servers (hot) for that instant: the lock wait is bounded so a long servers
-- transaction makes the deploy retry instead of queueing reads behind it. Rolling deploy: an
-- older replica neither reads nor writes the column.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "member_context_export_enabled" boolean DEFAULT false NOT NULL;
