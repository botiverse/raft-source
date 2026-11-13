-- The preview request versions an App's link-preview registration declares it
-- answers (PUT /api/oauth/link-preview `preview_versions`; #proj-apps
-- e1a02bef / eb7082bc). Every existing registration, and every row written by
-- code from before this column, gets {1}: an App that declared nothing answers
-- version 1 only. A constant default on ADD COLUMN rewrites no rows. Give up
-- after 2 s rather than queue preview reads behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "preview_versions" smallint[] DEFAULT '{1}'::smallint[] NOT NULL;
