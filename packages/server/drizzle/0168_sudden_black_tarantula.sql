CREATE TABLE "oauth_client_maintainers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"agent_id" uuid,
	"user_id" uuid,
	"role" text DEFAULT 'owner' NOT NULL,
	"assigned_by_type" text NOT NULL,
	"assigned_by_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_client_maintainers_principal_valid" CHECK (("oauth_client_maintainers"."principal_type" = 'agent' AND "oauth_client_maintainers"."agent_id" IS NOT NULL AND "oauth_client_maintainers"."user_id" IS NULL)
      OR ("oauth_client_maintainers"."principal_type" = 'human' AND "oauth_client_maintainers"."user_id" IS NOT NULL AND "oauth_client_maintainers"."agent_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "oauth_client_maintainers" ADD CONSTRAINT "oauth_client_maintainers_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_maintainers" ADD CONSTRAINT "oauth_client_maintainers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_maintainers" ADD CONSTRAINT "oauth_client_maintainers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_client_maintainers_client" ON "oauth_client_maintainers" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_client_maintainers_agent" ON "oauth_client_maintainers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_client_maintainers_user" ON "oauth_client_maintainers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_client_maintainers_active_owner" ON "oauth_client_maintainers" USING btree ("client_id") WHERE "oauth_client_maintainers"."role" = 'owner' AND "oauth_client_maintainers"."revoked_at" IS NULL;
--> statement-breakpoint
INSERT INTO "oauth_client_maintainers" (
	"id", "client_id", "principal_type", "agent_id", "role",
	"assigned_by_type", "assigned_by_id", "assigned_at"
)
SELECT
	md5(random()::text || clock_timestamp()::text || "id"::text)::uuid,
	"id", 'agent', "owner_agent_id", 'owner',
	'system', NULL, now()
FROM "oauth_clients"
WHERE "owner_agent_id" IS NOT NULL;
