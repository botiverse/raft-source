CREATE TABLE "server_membership_departures" (
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid,
	"departed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_membership_departures_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "server_membership_departures" ADD CONSTRAINT "server_membership_departures_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_membership_departures" ADD CONSTRAINT "server_membership_departures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_membership_departures" ADD CONSTRAINT "server_membership_departures_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_server_membership_departures_user" ON "server_membership_departures" USING btree ("user_id");