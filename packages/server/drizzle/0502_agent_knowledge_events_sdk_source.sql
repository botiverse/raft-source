-- Manual requests from the raft SDK (and the cloud runtime, which names no
-- client) are recorded with source 'sdk' (routes/agentKnowledge.ts
-- resolveKnowledgeSource). Every existing row is 'cli' and satisfies the wider
-- CHECK, so NOT VALID skips rescanning them under the DDL lock (the table is
-- append-only, never pruned); PostgreSQL still enforces the new rule on every
-- new or updated row. A later VALIDATE CONSTRAINT is optional.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_knowledge_events" DROP CONSTRAINT "agent_knowledge_events_source_valid";--> statement-breakpoint
ALTER TABLE "agent_knowledge_events" ADD CONSTRAINT "agent_knowledge_events_source_valid" CHECK ("agent_knowledge_events"."source" IN ('cli', 'sdk')) NOT VALID;
