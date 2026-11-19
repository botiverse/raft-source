-- Read-only on the target PostgreSQL database before building 081.
-- Require exactly these three rows, each is_nullable='NO'. Retain the result.
SELECT table_name,column_name,is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND column_name='joined_at'
  AND table_name IN ('joint_channel_members','server_members','joint_channel_servers')
ORDER BY table_name;
