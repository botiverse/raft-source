CREATE TABLE "agent_voice_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"caller_user_id" uuid NOT NULL,
	"session_id" text,
	"state" text DEFAULT 'starting' NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"end_reason" text,
	"duration_s" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"record_posted_at" timestamp with time zone,
	CONSTRAINT "agent_voice_calls_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "agent_voice_calls" ADD CONSTRAINT "agent_voice_calls_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_voice_calls" ADD CONSTRAINT "agent_voice_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_voice_calls" ADD CONSTRAINT "agent_voice_calls_caller_user_id_users_id_fk" FOREIGN KEY ("caller_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_voice_calls_agent_created" ON "agent_voice_calls" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_voice_calls_caller_created" ON "agent_voice_calls" USING btree ("caller_user_id","created_at");