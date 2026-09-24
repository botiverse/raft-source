-- Enable onboarding_opener_v2 for all new servers (full launch).
-- 0142 seeded the flag with default_enabled=false (fail-closed at ship time).
-- This turns audience to all so the onboarding release enables it on deploy,
-- with no separate prod flag flip. Idempotent.
UPDATE "feature_flags" SET "default_enabled" = true WHERE "key" = 'onboarding_opener_v2';
