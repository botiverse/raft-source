CREATE TABLE "assistant_owner_notes" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"notes" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_provisions" ADD COLUMN "instructions_version" text;--> statement-breakpoint
ALTER TABLE "assistant_owner_notes" ADD CONSTRAINT "assistant_owner_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;