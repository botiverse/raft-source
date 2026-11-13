CREATE TABLE "agent_turn_triggers" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"turn_id" uuid NOT NULL,
	"trigger_message_ids" text[] NOT NULL,
	"wechat_restricted" boolean NOT NULL,
	"wechat_allowed_channel_id" uuid,
	"turn_started_at" timestamp with time zone NOT NULL,
	"last_trigger_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_wechat_mirror_marks" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"inbound_random_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" ADD CONSTRAINT "agent_turn_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_wechat_mirror_marks" ADD CONSTRAINT "assistant_wechat_mirror_marks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_wechat_mirror_marks" ADD CONSTRAINT "assistant_wechat_mirror_marks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_wechat_mirror_marks_agent" ON "assistant_wechat_mirror_marks" USING btree ("agent_id");
