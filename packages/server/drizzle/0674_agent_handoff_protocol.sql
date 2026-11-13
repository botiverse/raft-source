ALTER TABLE "oauth_access_requests" ADD COLUMN "agent_handoff_challenge" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "agent_handoff_protocol" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_access_requests_agent_handoff_challenge" ON "oauth_access_requests" USING btree ("agent_id","client_id","agent_handoff_challenge") WHERE agent_handoff_challenge IS NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_agent_handoff_protocol_valid" CHECK ("oauth_clients"."agent_handoff_protocol" in ('legacy', 'v1'));
--> statement-breakpoint
CREATE FUNCTION prevent_agent_handoff_protocol_downgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.agent_handoff_protocol = 'v1' AND NEW.agent_handoff_protocol <> 'v1' THEN
    RAISE EXCEPTION 'agent handoff protocol cannot be downgraded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER oauth_clients_prevent_agent_handoff_downgrade BEFORE UPDATE OF agent_handoff_protocol ON oauth_clients FOR EACH ROW EXECUTE FUNCTION prevent_agent_handoff_protocol_downgrade();
