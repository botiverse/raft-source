CREATE TABLE "action_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"requester_agent_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"executed_at" timestamp with time zone,
	"executed_by_user_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_executed_by_user_id_users_id_fk" FOREIGN KEY ("executed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_action_cards_message" ON "action_cards" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_action_cards_server_state" ON "action_cards" USING btree ("server_id","state");--> statement-breakpoint
CREATE INDEX "idx_action_cards_requester" ON "action_cards" USING btree ("requester_agent_id","created_at");