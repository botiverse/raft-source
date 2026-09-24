CREATE TABLE "server_member_role_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"previous_role" text NOT NULL,
	"next_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_member_role_audit_previous_role_check" CHECK ("server_member_role_audit_events"."previous_role" IN ('owner', 'admin', 'member', 'guest')),
	CONSTRAINT "server_member_role_audit_next_role_check" CHECK ("server_member_role_audit_events"."next_role" IN ('owner', 'admin', 'member', 'guest')),
	CONSTRAINT "server_member_role_audit_transition_check" CHECK ("server_member_role_audit_events"."previous_role" <> "server_member_role_audit_events"."next_role")
);
--> statement-breakpoint
ALTER TABLE "server_member_role_audit_events" ADD CONSTRAINT "server_member_role_audit_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_member_role_audit_events" ADD CONSTRAINT "server_member_role_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_member_role_audit_events" ADD CONSTRAINT "server_member_role_audit_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_server_member_role_audit_server_created" ON "server_member_role_audit_events" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_server_member_role_audit_target_created" ON "server_member_role_audit_events" USING btree ("target_user_id","created_at");