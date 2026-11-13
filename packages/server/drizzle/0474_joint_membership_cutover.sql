SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
--> statement-breakpoint
CREATE TABLE "joint_membership_departures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"joint_channel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"local_channel_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "joint_membership_generations" (
	"joint_channel_id" uuid NOT NULL,
	"principal_kind" text DEFAULT 'user' NOT NULL,
	"principal_id" uuid NOT NULL,
	"last_generation" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "joint_membership_generations_joint_channel_id_principal_kind_principal_id_pk" PRIMARY KEY("joint_channel_id","principal_kind","principal_id"),
	CONSTRAINT "joint_membership_generation_positive" CHECK ("joint_membership_generations"."last_generation">0),
	CONSTRAINT "joint_membership_generation_kind" CHECK ("joint_membership_generations"."principal_kind"='user')
);
--> statement-breakpoint
CREATE TABLE "joint_membership_removals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"departure_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"membership_removed_at" timestamp with time zone,
	"remove_membership" boolean DEFAULT true NOT NULL,
	CONSTRAINT "joint_removal_one_principal" CHECK (("joint_membership_removals"."user_id" IS NULL) <> ("joint_membership_removals"."agent_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" DROP CONSTRAINT "joint_channel_admissions_joint_channel_id_user_id_server_id_pk";--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_joint_channel_id_user_id_generation_server_id_pk" PRIMARY KEY("joint_channel_id","user_id","generation","server_id");--> statement-breakpoint
ALTER TABLE "joint_channel_members" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Preserve one current episode for both migrated sources, and retain a number
-- for departed people even if their historical sources are later removed.
INSERT INTO joint_membership_generations (joint_channel_id,principal_kind,principal_id,last_generation)
SELECT joint_channel_id,'user',user_id,max(generation) FROM (
  SELECT joint_channel_id,user_id,generation FROM joint_channel_members
  UNION ALL SELECT joint_channel_id,user_id,generation FROM joint_channel_admissions
) episodes GROUP BY joint_channel_id,user_id
ON CONFLICT(joint_channel_id,principal_kind,principal_id) DO UPDATE
SET last_generation=greatest(joint_membership_generations.last_generation,excluded.last_generation);

--> statement-breakpoint
-- Sources already invalid at cutover must not revive on a later server rejoin.
UPDATE joint_channel_admissions a SET ended_at=now()
WHERE a.ended_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM joint_channel_servers p JOIN joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
  JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.type='joint' AND c.deleted_at IS NULL
  JOIN servers s ON s.id=p.server_id AND s.deleted_at IS NULL
  JOIN server_members sm ON sm.server_id=p.server_id AND sm.user_id=a.user_id AND sm.role<>'guest'
  WHERE p.joint_channel_id=a.joint_channel_id AND p.server_id=a.server_id AND p.status='active'
);

--> statement-breakpoint
ALTER TABLE "joint_membership_departures" ADD CONSTRAINT "joint_membership_departures_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_departures" ADD CONSTRAINT "joint_membership_departures_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_departures" ADD CONSTRAINT "joint_membership_departures_local_channel_id_channels_id_fk" FOREIGN KEY ("local_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_departures" ADD CONSTRAINT "joint_membership_departures_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_generations" ADD CONSTRAINT "joint_membership_generations_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_generations" ADD CONSTRAINT "joint_membership_generations_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_removals" ADD CONSTRAINT "joint_membership_removals_departure_id_joint_membership_departures_id_fk" FOREIGN KEY ("departure_id") REFERENCES "public"."joint_membership_departures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_removals" ADD CONSTRAINT "joint_membership_removals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_membership_removals" ADD CONSTRAINT "joint_membership_removals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_departures_pending_connection" ON "joint_membership_departures" USING btree ("joint_channel_id","server_id") WHERE "joint_membership_departures"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_joint_departures_local" ON "joint_membership_departures" USING btree ("local_channel_id");--> statement-breakpoint
CREATE INDEX "idx_joint_departures_server" ON "joint_membership_departures" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_joint_departures_actor" ON "joint_membership_departures" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "idx_joint_membership_generations_principal" ON "joint_membership_generations" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_removals_user" ON "joint_membership_removals" USING btree ("user_id","departure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_removals_agent" ON "joint_membership_removals" USING btree ("agent_id","departure_id");--> statement-breakpoint
CREATE INDEX "idx_joint_removals_departure" ON "joint_membership_removals" USING btree ("departure_id","id");
--> statement-breakpoint
