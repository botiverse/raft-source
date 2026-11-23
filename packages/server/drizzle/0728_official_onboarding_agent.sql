-- servers.onboarding_agent_id meant two things: the joiner greeter (any agent an
-- owner/admin picks in Settings → Onboarding) and the official onboarding agent
-- (Cindy), whose presence also counted as "setup done". Picking an ordinary agent
-- as greeter on a server whose owner had not finished setup therefore completed
-- setup, made setup report official_onboarding_agent_unusable and made Create
-- Cindy answer 409. Split them: official_onboarding_agent_id is Cindy only;
-- onboarding_agent_id stays the greeter and is never a setup signal.
--
-- 1. The new nullable column (no default: no rewrite).
-- 2. Backfill: a greeter that is this server's Cindy becomes its official
--    onboarding agent: a live agent of that server named Cindy, compared the way
--    Create Cindy's duplicate check compares names (trimmed, case-insensitive;
--    routes/agents.ts), so an old 'cindy' that blocks a second Cindy is linked too.
--    Deliberately NOT hasOfficialOnboardingAgentIdentity: that strict check
--    (display name, description, pixel:mug, admin role) judges whether a Cindy is
--    *usable* (setup state's usable/unusable) and stays there. Old Cindys and
--    owner-edited ones fail it, and are exactly the agents identity adoption
--    exists to repair; leaving their pointer NULL would turn them from
--    "unusable" into "missing" (a second hosted Cindy from the setup backstop,
--    Create Cindy no longer refused, no briefing, no adoption). A deleted Cindy
--    is backfilled too: deleting Cindy does not clear the official pointer
--    ("this server had its Cindy"), and skipping her would let the setup
--    backstop create a hosted Cindy on a finished server. Every other greeter
--    stays NULL:
--    it was only ever a greeter.
-- 3. Setup completion no longer reads the pointer
--    (serverSetupCompletionService), only server_members.setup_status. A server
--    with an official Cindy but no completed member row was complete only
--    through the pointer; record it the way the code records an owner who
--    inherits a completed server (serverService
--    reconcileOwnersToSetupCheckpoint): every owner row not yet complete becomes
--    complete / 'grandfathered'. That is also what setup projected for them
--    before (a synthesized 'grandfathered': no survey or handoff owed), so no
--    owner sees a change.
--
-- An older node during the rolling deploy never reads or writes the column. A
-- Cindy it links in that window gets only the greeter pointer; her owner is
-- already complete (createAgent stamps the owner in the agent's transaction),
-- so only the official pointer is missing, and a second Cindy is still refused
-- by name. A follow-up migration repeating statement 2, limited to rows whose
-- official_onboarding_agent_id is still NULL, fills those in.
--
-- servers and server_members are hot tables: give up on a lock after 2 s (the
-- deploy retries) rather than queue reads behind this transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "official_onboarding_agent_id" uuid;--> statement-breakpoint
UPDATE "servers" AS s
SET "official_onboarding_agent_id" = s."onboarding_agent_id"
FROM "agents" AS a
WHERE a."id" = s."onboarding_agent_id"
  AND a."server_id" = s."id"
  AND lower(btrim(a."name")) = 'cindy';--> statement-breakpoint
UPDATE "server_members" AS sm
SET "setup_status" = 'complete', "setup_completion_reason" = 'grandfathered'
FROM "servers" AS s
WHERE sm."server_id" = s."id"
  AND s."official_onboarding_agent_id" IS NOT NULL
  AND sm."role" = 'owner'
  AND sm."setup_status" <> 'complete'
  AND NOT EXISTS (
    SELECT 1 FROM "server_members" AS done
    WHERE done."server_id" = s."id" AND done."setup_status" = 'complete'
  );
