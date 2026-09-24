-- Migrate sleeping agents to active (sleeping state removed)
UPDATE "agents" SET "status" = 'active' WHERE "status" = 'sleeping';
