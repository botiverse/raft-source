-- consumed_via gains `acted`: an agent dealt with an app notice's object
-- through the app itself (read or commented on that Artifact), which consumes
-- its unread notices about it (consumeAgentObjectNotices, #raft-antiproton:#16).
--
-- third_party_agent_events is hot and large: the CHECK is swapped NOT VALID
-- (no scan, as 0652 added it), under a short lock timeout (the deploy
-- retries) rather than queueing event writes behind a long transaction.
-- Rolling deploy and rollback: older code only writes read | dismissed,
-- which the new CHECK still allows.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "third_party_agent_events" DROP CONSTRAINT "third_party_agent_events_consumed_via_known";--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_consumed_via_known" CHECK ("third_party_agent_events"."consumed_via" is null or "third_party_agent_events"."consumed_via" in ('read', 'dismissed', 'acted')) NOT VALID;
