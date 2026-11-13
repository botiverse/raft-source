-- RFC 084 §4: Raft's link-preview and card-action assertions use the client id
-- the App last proved in its domain file, so a rename doesn't change them until
-- the file names the new id. Every registration proved the current key so far.
-- Nullable: replicas still on the old code insert without it during the deploy.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "proved_client_key" text;--> statement-breakpoint
UPDATE "oauth_app_link_previews" AS preview
   SET "proved_client_key" = client."client_id"
  FROM "oauth_clients" AS client
 WHERE client."id" = preview."client_id";
