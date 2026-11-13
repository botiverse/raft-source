-- seat_join_blocks (task #10 #proj-commercial, behind pro_seat_add): someone
-- a full invite or join link turned away, recorded when their signed-in page
-- says so, for the notice to the server's owners, admins and the link's
-- creator. One active row per person and server (partial unique index).
--
-- Additive: a new, empty table, so its plain foreign keys check no rows. They
-- take SHARE ROW EXCLUSIVE on servers and users until the migration commits:
-- reads go on, writes to those two wait that long. The lock wait is bounded
-- so a long transaction makes the deploy retry instead of queueing writes
-- behind it.
--
-- Rollback: rows exist only while pro_seat_add is on; the previous release
-- never reads the table, so it can stay (or be dropped).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "seat_join_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"inviter_user_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_reason" text,
	CONSTRAINT "seat_join_blocks_state_shape" CHECK (("seat_join_blocks"."state" = 'active' AND "seat_join_blocks"."resolved_at" IS NULL AND "seat_join_blocks"."resolved_reason" IS NULL)
      OR ("seat_join_blocks"."state" = 'resolved' AND "seat_join_blocks"."resolved_at" IS NOT NULL AND "seat_join_blocks"."resolved_reason" IN ('joined', 'room', 'expired')))
);
--> statement-breakpoint
ALTER TABLE "seat_join_blocks" ADD CONSTRAINT "seat_join_blocks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_join_blocks" ADD CONSTRAINT "seat_join_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_join_blocks" ADD CONSTRAINT "seat_join_blocks_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_seat_join_blocks_active" ON "seat_join_blocks" USING btree ("server_id","user_id") WHERE "seat_join_blocks"."state" = 'active';