-- Agent Lounge v0 (#proj-chat:#15, behind agent_lounge_v0): agent_lounges
-- marks a public channel as one agent's lounge, where every non-guest human of
-- the Server talks with that agent. Other agents may read it like any public
-- channel but never take part, so channel_agents_agent_lounge_guard refuses a
-- channel_agents row for any agent but the lounge's own: every write that
-- needs channel membership (post, react, mute, tasks) stays closed to them,
-- whichever route asks. agent_lounges_binding_guard keeps the binding itself
-- from being pointed at a channel other agents are already in, or moved to
-- another agent; the agent row going away (ON DELETE SET NULL) leaves the
-- channel a lounge closed to every agent.
--
-- Lock budget: agent_lounges is new and empty. Its channels FK takes SHARE ROW
-- EXCLUSIVE on channels (hot), so it is added NOT VALID and validated
-- separately, as in 0515; the trigger takes SHARE ROW EXCLUSIVE on
-- channel_agents for an instant. Fail fast rather than queue writers behind
-- the DDL (the deploy retries).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "agent_lounges" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_lounges" ADD CONSTRAINT "agent_lounges_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_lounges" VALIDATE CONSTRAINT "agent_lounges_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "agent_lounges" ADD CONSTRAINT "agent_lounges_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lounges" ADD CONSTRAINT "agent_lounges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_lounges_agent" ON "agent_lounges" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_lounges_server" ON "agent_lounges" USING btree ("server_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_agent_lounge_outsider_agent"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "agent_lounges" l
		WHERE l."channel_id" = NEW."channel_id"
			AND l."agent_id" IS DISTINCT FROM NEW."agent_id"
	) THEN
		RAISE EXCEPTION 'agent % may not join agent lounge %', NEW."agent_id", NEW."channel_id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'channel_agents_agent_lounge_guard';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "channel_agents_agent_lounge_guard"
BEFORE INSERT OR UPDATE OF "channel_id", "agent_id" ON "channel_agents"
FOR EACH ROW EXECUTE FUNCTION "reject_agent_lounge_outsider_agent"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_lounge_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND (
		NEW."channel_id" <> OLD."channel_id"
		OR (NEW."agent_id" IS NOT NULL AND NEW."agent_id" IS DISTINCT FROM OLD."agent_id")
	) THEN
		RAISE EXCEPTION 'agent lounge % binding is immutable', OLD."channel_id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_lounges_binding_guard';
	END IF;
	IF TG_OP = 'INSERT' AND EXISTS (
		SELECT 1 FROM "channel_agents" ca
		WHERE ca."channel_id" = NEW."channel_id"
			AND ca."agent_id" IS DISTINCT FROM NEW."agent_id"
	) THEN
		RAISE EXCEPTION 'channel % already has other agents and cannot become a lounge', NEW."channel_id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_lounges_binding_guard';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_lounges_binding_guard"
BEFORE INSERT OR UPDATE ON "agent_lounges"
FOR EACH ROW EXECUTE FUNCTION "guard_agent_lounge_binding"();
