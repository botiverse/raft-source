CREATE TABLE "agent_channel_read_cursors" (
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_channel_read_cursors_agent_id_channel_id_pk" PRIMARY KEY("agent_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "agent_channel_read_cursors" ADD CONSTRAINT "agent_channel_read_cursors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channel_read_cursors" ADD CONSTRAINT "agent_channel_read_cursors_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;