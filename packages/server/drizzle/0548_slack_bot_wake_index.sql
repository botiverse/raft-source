-- Existing installations can have a large ingress table. Building this index
-- inside the transactional migrator would block writes. db:migrate:deploy
-- creates it CONCURRENTLY after this migration and verifies its catalog shape
-- before starting the new server; local raftdev follows the same steps.
SELECT 1;
