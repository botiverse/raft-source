-- The Wiki contract drop is intentionally deferred until the rolling-deploy
-- rollback window has closed. Keep this journal slot as a harmless migration
-- so 0203 can apply without falsifying or bypassing Drizzle's linear history.
-- A future tail migration must carry the reviewed DROP statements.
SELECT 1;
