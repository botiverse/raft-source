-- RFC 087 §4 (MCP App accounts), additive. Schema for personal Connections and their grants, which
-- later releases write; with no personal rows, admission is today's (managedMcpService.ts
-- admitManagedMcpCall).
--
-- - managed_mcp_credentials.owner_kind ('shared' | 'personal', every existing row 'shared') and
--   owner_user_id (the member a personal Connection belongs to). CHECK: personal iff an owner, and a
--   personal Connection is never the server default. Index (mcp_server_id, owner_user_id). The trigger
--   managed_mcp_credentials_owner_immutable refuses changing either after insert (a shared Connection
--   never becomes someone's own, nor the reverse; grants and pins rely on it).
-- - managed_mcp_servers.members_can_connect (default off).
-- - managed_mcp_personal_grants: one personal Connection per Agent and App. The trigger
--   managed_mcp_personal_grants_connection_guard refuses a connection_id that is not a personal
--   Connection of the same App, on the Agent's Server.
--
-- Data step: the rule "an Agent may use the server default or a Connection its owner created" goes
-- away in this release, which would turn every pin refused by it today (pinned to a Connection that
-- is not the default and was not created by the Agent's owner: a personal assistant's owner, else
-- its human creator) into a working one. Those pins lose their Connection (bound_connection_id NULL)
-- and stay 'pinned', so they keep answering login_required, as now, until an admin pins the Agent
-- again. Usable pins are untouched. The count is reported as a MIGRATION_REPORT notice
-- (scripts/migrate-deploy.ts prints it after commit).
--
-- Rollout: the previous binary ignores the new columns and table; the default 'shared' keeps its
-- inserts valid. A pin cleared here is refused by it exactly as before (the ownership rule refused
-- it). A pin written by this release to another person's shared Connection is refused by the
-- previous binary until it is replaced (fail-closed).
--
-- Locks: managed_mcp_credentials and managed_mcp_servers are small (one row per Connection / App):
-- catalog-only ADD COLUMNs with constant defaults, a CHECK and an index built under the table's
-- lock. The new table's keys take SHARE ROW EXCLUSIVE on agents and servers. The keys to users (hot)
-- come last; the credentials one NOT VALID (every value is NULL). 2 s lock wait, then the deploy
-- retries.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "managed_mcp_personal_grants" (
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_mcp_personal_grants_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "owner_kind" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "members_can_connect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_mcp_personal_grants" ADD CONSTRAINT "managed_mcp_personal_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_personal_grants" ADD CONSTRAINT "managed_mcp_personal_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_personal_grants" ADD CONSTRAINT "managed_mcp_personal_grants_mcp_server_id_managed_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."managed_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_personal_grants" ADD CONSTRAINT "managed_mcp_personal_grants_connection_id_managed_mcp_credentials_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."managed_mcp_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_personal_grants_server_agent" ON "managed_mcp_personal_grants" USING btree ("server_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_personal_grants_mcp_server" ON "managed_mcp_personal_grants" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_personal_grants_connection" ON "managed_mcp_personal_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_credentials_owner" ON "managed_mcp_credentials" USING btree ("mcp_server_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_owner_kind_valid" CHECK (("managed_mcp_credentials"."owner_kind" = 'shared' AND "managed_mcp_credentials"."owner_user_id" IS NULL) OR ("managed_mcp_credentials"."owner_kind" = 'personal' AND "managed_mcp_credentials"."owner_user_id" IS NOT NULL AND NOT "managed_mcp_credentials"."is_server_default"));--> statement-breakpoint
CREATE FUNCTION "public"."managed_mcp_personal_grants_connection_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."managed_mcp_credentials" c
      JOIN "public"."agents" a ON a."id" = NEW."agent_id" AND a."server_id" = c."server_id"
     WHERE c."id" = NEW."connection_id"
       AND c."mcp_server_id" = NEW."mcp_server_id"
       AND c."server_id" = NEW."server_id"
       AND c."owner_kind" = 'personal'
  ) THEN
    RAISE EXCEPTION 'connection_id must be a personal Connection of the same App, on the Agent''s Server'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_mcp_personal_grants_connection_guard';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "managed_mcp_personal_grants_connection_guard" BEFORE INSERT OR UPDATE ON "public"."managed_mcp_personal_grants"
  FOR EACH ROW EXECUTE FUNCTION "public"."managed_mcp_personal_grants_connection_guard"();--> statement-breakpoint
CREATE FUNCTION "public"."managed_mcp_credentials_owner_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."owner_kind" IS DISTINCT FROM OLD."owner_kind" OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id" THEN
    RAISE EXCEPTION 'a Connection''s owner_kind and owner_user_id cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_mcp_credentials_owner_immutable';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "managed_mcp_credentials_owner_immutable" BEFORE UPDATE OF "owner_kind", "owner_user_id" ON "public"."managed_mcp_credentials"
  FOR EACH ROW EXECUTE FUNCTION "public"."managed_mcp_credentials_owner_immutable"();--> statement-breakpoint
DO $$
DECLARE
  cleared integer;
BEGIN
  UPDATE "managed_mcp_assignments" a SET "bound_connection_id" = NULL, "updated_at" = now()
    FROM "managed_mcp_credentials" c, "agents" g
   WHERE a."connection_mode" = 'pinned'
     AND c."id" = a."bound_connection_id"
     AND g."id" = a."agent_id"
     AND NOT c."is_server_default"
     AND NOT COALESCE(
       c."created_by_user_id" = COALESCE(g."assistant_owner_user_id", CASE WHEN g."creator_type" = 'user' THEN g."creator_id" END),
       false
     );
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RAISE NOTICE 'MIGRATION_REPORT migration=managed_mcp_personal_accounts cleared_pins=%', cleared;
END
$$;--> statement-breakpoint
ALTER TABLE "managed_mcp_personal_grants" ADD CONSTRAINT "managed_mcp_personal_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
