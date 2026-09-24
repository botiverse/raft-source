CREATE TABLE "rap_app_configs" (
	"server_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"subject_agent_id" uuid NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rap_app_configs_server_app_subject_pk" PRIMARY KEY("server_id","app_id","subject_agent_id")
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "arm_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "armed_version" integer;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "arm_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rap_app_configs" ADD CONSTRAINT "rap_app_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rap_app_configs" ADD CONSTRAINT "rap_app_configs_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;