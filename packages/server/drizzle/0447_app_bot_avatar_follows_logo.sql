-- An App bot's avatar IS its App's logo (appBotIdentityService
-- syncManagedAppBotAvatars keeps it so on bot creation and every logo write).
-- Bots created before that hold NULL (the generated avatar): copy the logo
-- now, for every bot still linked to an installation. NULL logo stays NULL.
-- Data only, no DDL: row locks on the few App bot rows of `agents`, which is
-- written often; give up after 5 s rather than wait behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
UPDATE "agents" AS a
SET "avatar_url" = c."logo_url", "updated_at" = now()
FROM "oauth_client_installs" AS i
INNER JOIN "oauth_clients" AS c ON c."id" = i."client_id"
WHERE a."managed_by_app_install_id" = i."id"
  AND a."avatar_url" IS DISTINCT FROM c."logo_url";
