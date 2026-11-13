CREATE TABLE "assistant_doorbell_sources" (
	"agent_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"max_seq" bigint NOT NULL,
	CONSTRAINT "assistant_doorbell_sources_agent_id_source_channel_id_pk" PRIMARY KEY("agent_id","source_channel_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_doorbell_sources" ADD CONSTRAINT "assistant_doorbell_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;