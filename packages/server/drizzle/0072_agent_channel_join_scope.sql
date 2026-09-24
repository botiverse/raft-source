UPDATE "agent_scopes"
SET
  "scopes" = "scopes" || '["channel:join"]'::jsonb,
  "revision" = "revision" + 1,
  "updated_at" = now()
WHERE NOT ("scopes" ? 'channel:join');
