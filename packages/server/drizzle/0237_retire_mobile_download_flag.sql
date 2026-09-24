-- Mobile app download discovery is now available by default. Remove the stale
-- admin catalog entry so it cannot imply that the retired runtime gate still
-- controls the UI. Related rollout rules cascade with the feature flag row.
DELETE FROM "feature_flags"
WHERE "key" = 'mobile_download_v0';
