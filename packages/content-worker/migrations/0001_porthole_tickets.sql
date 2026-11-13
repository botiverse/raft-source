-- One-time tickets for Raft's workspace Artifact frames (w-<uuid>.<content
-- domain>), exactly @botiverse/porthole's d1TicketSchema(): the row is keyed
-- by the ticket's hash, holds its grant (the instance, Raft's viewer and
-- subject), is taken once by an atomic DELETE ... RETURNING and lives a
-- minute. The content Worker's only table.
CREATE TABLE IF NOT EXISTS porthole_tickets (id TEXT PRIMARY KEY, record TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS porthole_tickets_expires_at ON porthole_tickets (expires_at);
