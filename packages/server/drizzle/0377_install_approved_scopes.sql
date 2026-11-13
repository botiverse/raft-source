-- oauth_client_installs.approved_scopes: the OAuth login scopes the installer
-- approved (task #2, #proj-apps). Agents are auto-granted only within this set.
-- Existing installations get their app's current effective scopes, so agent
-- grants behave exactly as before at deploy; only scopes a developer adds from
-- now on wait for an admin. An app with no explicit allowed_scopes uses
-- RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES (openid, profile, identity), matching
-- allowedScopesForClient. The '[]' default fails closed for an insert path
-- that forgets to set the column.
-- oauth_client_installs is small (hundreds of rows); bound the lock wait so a
-- long transaction makes the deploy retry instead of queueing install reads.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "approved_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "oauth_client_installs" AS "i" SET "approved_scopes" = CASE
  WHEN "c"."allowed_scopes" IS NULL THEN '["openid","profile","identity"]'::jsonb
  WHEN json_typeof("c"."allowed_scopes") <> 'array' THEN '["openid","profile","identity"]'::jsonb
  WHEN json_array_length("c"."allowed_scopes") = 0 THEN '["openid","profile","identity"]'::jsonb
  ELSE "c"."allowed_scopes"::jsonb
END
FROM "oauth_clients" AS "c"
WHERE "c"."id" = "i"."client_id";
