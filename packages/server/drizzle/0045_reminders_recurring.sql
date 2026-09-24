CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"msg_id" uuid,
	"title" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"payload" json,
	"recurrence" jsonb,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"fired_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reminders_due" ON "reminders" USING btree ("status","fire_at");--> statement-breakpoint
CREATE INDEX "idx_reminders_owner" ON "reminders" USING btree ("owner_agent_id","status","fire_at");--> statement-breakpoint
CREATE INDEX "idx_reminders_server" ON "reminders" USING btree ("server_id");