-- WeChat line (services/wechatLine.ts): line credentials on agent_credentials,
-- the push registration's declared capabilities and who configured it, the
-- per-line turn record and the WeChat line's own read cursor.
--
-- agent_turn_triggers: the primary key moves from (agent_id) to (agent_id, line).
-- Existing rows become line = 'main' (the column default): every one of them
-- was written by a hand-off to the agent's own (main) credential, which is
-- what `main` still means, and keeps its restriction until the next main turn
-- starts. The table holds one row per personal assistant, so the key swap is
-- instant.
--
-- agent_credentials: the new columns are nullable (every existing credential is
-- a main-line one) and the shape check is added NOT VALID (no scan; every
-- existing row has session_scope NULL and so satisfies it).
CREATE TABLE "assistant_wechat_line_deliveries" (
	"agent_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"turn_id" uuid NOT NULL,
	"handed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	CONSTRAINT "assistant_wechat_line_deliveries_agent_id_message_id_pk" PRIMARY KEY("agent_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" DROP CONSTRAINT "agent_turn_triggers_pkey";--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" ADD COLUMN "line" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" ADD COLUMN "idle_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" ADD CONSTRAINT "agent_turn_triggers_agent_id_line_pk" PRIMARY KEY("agent_id","line");--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "session_scope" text;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "bound_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "bound_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "parent_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "capabilities" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "configured_by" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_wechat_line_deliveries" ADD CONSTRAINT "assistant_wechat_line_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" ADD CONSTRAINT "agent_turn_triggers_line_valid" CHECK ("agent_turn_triggers"."line" IN ('main', 'wechat'));--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_session_scope_shape" CHECK ("agent_credentials"."session_scope" IS NULL OR ("agent_credentials"."session_scope" = 'wechat' AND "agent_credentials"."bound_channel_id" IS NOT NULL AND "agent_credentials"."bound_turn_id" IS NOT NULL AND "agent_credentials"."expires_at" IS NOT NULL)) NOT VALID;
