-- attested_send_events is large in production (millions of rows). Building
-- idx_attested_send_events_message inside the transactional migrator would
-- block writes to it. db:migrate:deploy creates it CONCURRENTLY after this
-- migration (db:create-attested-send-events-message-index) and verifies its
-- catalog shape before starting the new server; local raftdev follows the
-- same steps.
SELECT 1;
