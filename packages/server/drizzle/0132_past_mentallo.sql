CREATE TABLE "agent_migrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_machine_id" uuid NOT NULL,
	"target_machine_id" uuid NOT NULL,
	"state" text DEFAULT 'prep' NOT NULL,
	"grant_key" text NOT NULL,
	"initiated_by_user_id" uuid,
	"manifest_path" text,
	"manifest_sha256" text,
	"arrival_report_path" text,
	"arrival_report_sha256" text,
	"abort_reason" text,
	"failure_reason" text,
	"prep_deadline_at" timestamp with time zone NOT NULL,
	"transfer_deadline_at" timestamp with time zone NOT NULL,
	"arrival_deadline_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"flipped_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_migrations_grant_key_unique" UNIQUE("grant_key"),
	CONSTRAINT "agent_migrations_distinct_machines" CHECK ("agent_migrations"."source_machine_id" <> "agent_migrations"."target_machine_id")
);
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_source_machine_id_daemons_id_fk" FOREIGN KEY ("source_machine_id") REFERENCES "public"."daemons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_target_machine_id_daemons_id_fk" FOREIGN KEY ("target_machine_id") REFERENCES "public"."daemons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_migrations_server" ON "agent_migrations" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_migrations_agent" ON "agent_migrations" USING btree ("agent_id","state");--> statement-breakpoint
CREATE INDEX "idx_agent_migrations_source_machine" ON "agent_migrations" USING btree ("source_machine_id");--> statement-breakpoint
CREATE INDEX "idx_agent_migrations_target_machine" ON "agent_migrations" USING btree ("target_machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migrations_active_agent" ON "agent_migrations" USING btree ("agent_id") WHERE "agent_migrations"."state" IN ('prep', 'ready', 'in_transit', 'arriving');