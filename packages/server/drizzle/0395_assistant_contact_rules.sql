CREATE TABLE "assistant_contact_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"effect" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text,
	"subject_type" text,
	"legacy" jsonb,
	"anytime" boolean DEFAULT false NOT NULL,
	"until" timestamp with time zone,
	"note" text,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_assistant_contact_rules_source" UNIQUE("agent_id","source_id"),
	CONSTRAINT "uq_assistant_contact_rules_subject" UNIQUE NULLS NOT DISTINCT("agent_id","effect","subject_kind","subject_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_contact_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"quiet" jsonb,
	"stated_timezone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_told" (
	"agent_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"via" text NOT NULL,
	"told_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_told_agent_id_message_id_pk" PRIMARY KEY("agent_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_contact_rules" ADD CONSTRAINT "assistant_contact_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_contact_settings" ADD CONSTRAINT "assistant_contact_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_told" ADD CONSTRAINT "assistant_told_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_told_told_at" ON "assistant_told" USING btree ("told_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_told_agent_told_at" ON "assistant_told" USING btree ("agent_id","told_at");