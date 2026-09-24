-- Intentionally managed by the post-migration lifecycle step. Production must
-- build idx_messages_sender_created_at with CREATE INDEX CONCURRENTLY and
-- verify it is valid/ready; the transactional Drizzle migration only advances
-- the schema snapshot. (Same contract as 0236.)
SELECT 1;
