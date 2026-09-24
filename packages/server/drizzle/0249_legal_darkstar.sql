CREATE TABLE "channel_membership_role_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"previous_role" text NOT NULL,
	"next_role" text NOT NULL,
	"authority_revision" integer NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "channel_membership_role_events_target_type_check" CHECK ("channel_membership_role_events"."target_type" IN ('user', 'agent')),
	CONSTRAINT "channel_membership_role_events_previous_role_check" CHECK ("channel_membership_role_events"."previous_role" IN ('member', 'admin')),
	CONSTRAINT "channel_membership_role_events_next_role_check" CHECK ("channel_membership_role_events"."next_role" IN ('member', 'admin')),
	CONSTRAINT "channel_membership_role_events_delivery_status_check" CHECK ("channel_membership_role_events"."delivery_status" IN ('pending', 'sent', 'dead_letter'))
);
--> statement-breakpoint
ALTER TABLE "channel_agents" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD COLUMN "authority_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_humans" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_humans" ADD COLUMN "authority_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ADD CONSTRAINT "channel_membership_role_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ADD CONSTRAINT "channel_membership_role_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ADD CONSTRAINT "channel_membership_role_events_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_membership_role_events_pending" ON "channel_membership_role_events" USING btree ("delivery_status","created_at");--> statement-breakpoint
CREATE INDEX "idx_channel_membership_role_events_channel" ON "channel_membership_role_events" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_channel_agents_channel_role" ON "channel_agents" USING btree ("channel_id","role");--> statement-breakpoint
CREATE INDEX "idx_channel_humans_channel_role" ON "channel_humans" USING btree ("channel_id","role");--> statement-breakpoint
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_role_check" CHECK ("channel_agents"."role" IN ('member', 'admin'));--> statement-breakpoint
ALTER TABLE "channel_humans" ADD CONSTRAINT "channel_humans_role_check" CHECK ("channel_humans"."role" IN ('member', 'admin'));