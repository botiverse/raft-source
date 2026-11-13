-- A personal assistant (agents.assistant_owner_user_id set) is never bound to
-- a machine (agents.daemon_id). It runs hosted; every agent on a Computer
-- shares one OS user, so an assistant there would share its owner's private
-- surfaces with the other agents on that Computer. Until now this held only
-- because each write path happened to skip assistants; every such path now
-- refuses explicitly (AssistantCannotUseComputerError, computerAgents.ts) and
-- this CHECK makes it a rule of the table.
--
-- Part 1 of 2. `agents` is a hot table (~92k rows, ~66 MB). The CHECK is
-- added NOT VALID, so nothing is scanned under the ACCESS EXCLUSIVE lock: it
-- is catalog-only and binds new and updated rows from now on. The next
-- migration validates it under SHARE UPDATE EXCLUSIVE, which reads and writes
-- don't wait for (as 0469/0470, 0629/0630). The lock wait is bounded so a long
-- agents transaction makes the deploy retry instead of queueing agent reads
-- behind it.
--
-- Rolling deploy: an older replica never binds an assistant to a machine
-- either (assistants are external-runtime agents, which no machine write
-- path takes), so it cannot trip the CHECK.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_assistant_not_on_machine" CHECK ("agents"."assistant_owner_user_id" IS NULL OR "agents"."daemon_id" IS NULL) NOT VALID;
