CREATE TABLE "assistant_check_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"next_brief_at" timestamp with time zone,
	"brief_sent_day" text,
	"asked_timezone" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"brief_day" text,
	"items" jsonb NOT NULL,
	"notify_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_told" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_told" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "assistant_check_state" ADD CONSTRAINT "assistant_check_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_checks" ADD CONSTRAINT "assistant_checks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_check_state_next_brief" ON "assistant_check_state" USING btree ("next_brief_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_checks_agent_created" ON "assistant_checks" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_told_agent_channel" ON "assistant_told" USING btree ("agent_id","channel_id");