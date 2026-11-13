CREATE TABLE "oauth_user_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scopes" json NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_user_consents" ADD CONSTRAINT "oauth_user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_user_consents" ADD CONSTRAINT "oauth_user_consents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_user_consents" ADD CONSTRAINT "oauth_user_consents_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_user_consents_user_server_client" ON "oauth_user_consents" USING btree ("user_id","server_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_user_consents_client_server" ON "oauth_user_consents" USING btree ("client_id","server_id");--> statement-breakpoint
-- One consent per (person, Server, App) from their human tokens: scopes are the
-- union over the tokens, granted_at the first token, updated_at the latest, and
-- revoked_at the latest token's (a pair whose most recent token was revoked
-- stays revoked; an expired one still counts as consent). Ties on created_at
-- prefer the revoked token. One pass over the table; re-running is a no-op.
INSERT INTO "oauth_user_consents" ("id", "user_id", "server_id", "client_id", "scopes", "granted_at", "updated_at", "revoked_at")
SELECT
	gen_random_uuid(),
	t."user_id",
	t."server_id",
	t."client_id",
	COALESCE(json_agg(DISTINCT s.scope ORDER BY s.scope) FILTER (WHERE s.scope IS NOT NULL), '[]'::json),
	min(t."created_at"),
	max(t."created_at"),
	(array_agg(t."revoked_at" ORDER BY t."created_at" DESC, t."revoked_at" DESC NULLS LAST))[1]
FROM "oauth_access_tokens" t
LEFT JOIN LATERAL json_array_elements_text(
	CASE WHEN json_typeof(t."scopes") = 'array' THEN t."scopes" ELSE '[]'::json END
) AS s(scope) ON true
WHERE t."principal_type" = 'human'
	AND t."user_id" IS NOT NULL
	AND t."server_id" IS NOT NULL
	AND t."client_id" IS NOT NULL
GROUP BY t."user_id", t."server_id", t."client_id"
ON CONFLICT ("user_id", "server_id", "client_id") DO NOTHING;
