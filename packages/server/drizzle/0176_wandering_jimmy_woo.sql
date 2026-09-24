CREATE TABLE "dm_channel_identities" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"peer_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_channel_identities_kind" CHECK ("dm_channel_identities"."kind" in ('human_self', 'human_human', 'human_agent', 'agent_agent'))
);
--> statement-breakpoint
ALTER TABLE "dm_channel_identities" ADD CONSTRAINT "dm_channel_identities_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_channel_identities" ADD CONSTRAINT "dm_channel_identities_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dm_channel_identities_peer" ON "dm_channel_identities" USING btree ("server_id","kind","peer_key");--> statement-breakpoint
-- Backfill only membership shapes whose provenance is still exact. Singleton
-- human rows are intentionally excluded: they may be self-DMs or deleted-agent
-- DMs after channel_agents cleanup, and guessing would splice private history.
WITH "human_memberships" AS (
	SELECT "channel_id", count(*) AS "human_count",
		min("user_id"::text) AS "first_human_id",
		max("user_id"::text) AS "second_human_id"
	FROM "channel_humans"
	GROUP BY "channel_id"
), "agent_memberships" AS (
	SELECT "channel_id", count(*) AS "agent_count",
		min("agent_id"::text) AS "first_agent_id",
		max("agent_id"::text) AS "second_agent_id"
	FROM "channel_agents"
	GROUP BY "channel_id"
), "exact_dm_memberships" AS (
	SELECT c."id" AS "channel_id", c."server_id",
		coalesce(h."human_count", 0) AS "human_count",
		coalesce(a."agent_count", 0) AS "agent_count",
		h."first_human_id", h."second_human_id",
		a."first_agent_id", a."second_agent_id"
	FROM "channels" c
	LEFT JOIN "human_memberships" h ON h."channel_id" = c."id"
	LEFT JOIN "agent_memberships" a ON a."channel_id" = c."id"
	WHERE c."type" = 'dm'
		AND c."deleted_at" IS NULL
)
INSERT INTO "dm_channel_identities" ("channel_id", "server_id", "kind", "peer_key")
SELECT "channel_id", "server_id",
	CASE
		WHEN "human_count" = 1 AND "agent_count" = 1 THEN 'human_agent'
		WHEN "human_count" = 2 AND "agent_count" = 0 THEN 'human_human'
		ELSE 'agent_agent'
	END,
	CASE
		WHEN "human_count" = 1 AND "agent_count" = 1 THEN
			CASE WHEN "first_human_id" < "first_agent_id"
				THEN "first_human_id" || ':' || "first_agent_id"
				ELSE "first_agent_id" || ':' || "first_human_id"
			END
		WHEN "human_count" = 2 AND "agent_count" = 0 THEN
			"first_human_id" || ':' || "second_human_id"
		ELSE "first_agent_id" || ':' || "second_agent_id"
	END
FROM "exact_dm_memberships"
WHERE ("human_count" = 1 AND "agent_count" = 1)
	OR ("human_count" = 2 AND "agent_count" = 0)
	OR ("human_count" = 0 AND "agent_count" = 2)
ON CONFLICT (channel_id) DO NOTHING;
