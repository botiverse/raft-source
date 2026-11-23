-- What first-party objects name in their content (#proj-workspace:#336, step 1;
-- services/objectReferences.ts, reached by apps through platform/references):
-- one row per object a source's latest content names, the source and target
-- by kind and id as object_events names objects, in the source's order, with
-- the target kind's small facts (`target_detail`, at most 4 KiB; never text of
-- the source). First writer: Artifacts' links to other Artifacts
-- (apps/artifacts/references.ts). Backlinks read it by target
-- (idx_object_references_target); the closed-server purge deletes by
-- server_id (idx_object_references_server), as a server's delete cascades.
--
-- One new, empty table with all its constraints (nothing to validate). Its key
-- to servers takes SHARE ROW EXCLUSIVE on servers (hot) until this file
-- commits, so the file touches nothing else (the marker column on
-- app_artifacts.versions came in the previous file) and gives up after 2 s
-- (the deploy retries) rather than queue servers' writes behind it.
--
-- Rolling deploy and rollback: older server code never names the table; rows
-- are only ever written after a commit, and a missing one is read again.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "object_references" (
	"server_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"position" integer NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"target_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "object_references_source_kind_source_id_position_pk" PRIMARY KEY("source_kind","source_id","position"),
	CONSTRAINT "object_references_position" CHECK ("object_references"."position" >= 0),
	CONSTRAINT "object_references_detail_small" CHECK (pg_column_size("object_references"."target_detail") <= 4096)
);
--> statement-breakpoint
ALTER TABLE "object_references" ADD CONSTRAINT "object_references_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_object_references_target" ON "object_references" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "idx_object_references_server" ON "object_references" USING btree ("server_id");
