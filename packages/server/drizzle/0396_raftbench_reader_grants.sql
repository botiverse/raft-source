CREATE TABLE "raftbench_reader_grants" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raftbench_reader_grants" ADD CONSTRAINT "raftbench_reader_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raftbench_reader_grants" ADD CONSTRAINT "raftbench_reader_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raftbench_reader_grants" ADD CONSTRAINT "raftbench_reader_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_raftbench_reader_grant_subject" ON "raftbench_reader_grants" USING btree ("server_id","agent_id","seq");