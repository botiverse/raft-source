-- antiproton held-call approvals (docs/contracts/hosted-agent-approvals.md): new
-- tables only. Their foreign keys briefly lock messages, users, agents and
-- servers (SHARE ROW EXCLUSIVE); give up rather than queue behind a long
-- transaction on one of them.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "agent_runtime_approval_cards" (
	"approval_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_approval_cards_approval_id_user_id_pk" PRIMARY KEY("approval_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_approval_sync" (
	"provider_target" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_approval_sync_target_check" CHECK ("agent_runtime_approval_sync"."provider_target" IN ('default', 'canary'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider_target" text NOT NULL,
	"operation_id" text NOT NULL,
	"status" text NOT NULL,
	"item" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" jsonb,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_approvals_status_check" CHECK ("agent_runtime_approvals"."status" IN ('pending', 'approved', 'executed', 'failed', 'denied', 'expired', 'unavailable')),
	CONSTRAINT "agent_runtime_approvals_target_check" CHECK ("agent_runtime_approvals"."provider_target" IN ('default', 'canary'))
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_approval_cards" ADD CONSTRAINT "agent_runtime_approval_cards_approval_id_agent_runtime_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."agent_runtime_approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_approval_cards" ADD CONSTRAINT "agent_runtime_approval_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_approval_cards" ADD CONSTRAINT "agent_runtime_approval_cards_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_approvals" ADD CONSTRAINT "agent_runtime_approvals_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_approvals" ADD CONSTRAINT "agent_runtime_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_runtime_approval_cards_message" ON "agent_runtime_approval_cards" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_runtime_approvals_operation" ON "agent_runtime_approvals" USING btree ("agent_id","operation_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_approvals_server" ON "agent_runtime_approvals" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_approvals_pending" ON "agent_runtime_approvals" USING btree ("expires_at") WHERE status = 'pending';
