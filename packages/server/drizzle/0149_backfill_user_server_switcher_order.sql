UPDATE "users"
SET "server_switcher_order" = legacy_order."server_switcher_order"
FROM (
  SELECT DISTINCT ON ("user_id")
    "user_id",
    "server_switcher_order"
  FROM "server_members"
  WHERE "server_switcher_order" IS NOT NULL
  ORDER BY "user_id", "joined_at" ASC
) AS legacy_order
WHERE "users"."id" = legacy_order."user_id";
