-- Focus (agent_focus_v0): a manual unfocus sticks. `unfocused_at` is set when
-- the agent unfocuses a conversation; the row then stops being an entry and
-- only records that Raft must not focus the conversation by itself again
-- until the agent writes in it or focuses it. NULL on every entry.
--
-- Nullable, no default: a catalog-only change, no rewrite. The table is small
-- and only written with the flag on. Bound the wait for the table lock all the
-- same, as the migration that created the table does.
--
-- Rolling deploy and rollback: the previous release never sets the column, so
-- every row it writes is an entry. It would read a row with the column set as
-- an entry again; the flag is off everywhere, so there is none yet.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "agent_focus_targets" ADD COLUMN "unfocused_at" timestamp with time zone;
