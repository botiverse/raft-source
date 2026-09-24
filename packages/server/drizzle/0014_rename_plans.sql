-- Rename business plan to max (no business plan users exist yet).
-- Existing team plan users are grandfathered — team stays as team.
UPDATE "servers" SET "plan" = 'max' WHERE "plan" = 'business';