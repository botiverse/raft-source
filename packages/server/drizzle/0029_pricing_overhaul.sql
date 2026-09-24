-- Pricing overhaul: 14-day free trial + Founder plan for existing paid users.
--
-- 1. Convert all paid users (pro/max/team) to founder plan (permanent free unlimited).
-- 2. Clear all Stripe subscription records (switching to new Stripe account later).
-- 3. Clear webhook event history.
-- 4. Clear planDowngradedAt for all servers (no longer relevant after conversion).

-- Convert paid plans to founder
UPDATE "servers" SET "plan" = 'founder', "plan_downgraded_at" = NULL, "updated_at" = NOW()
  WHERE "plan" IN ('pro', 'max', 'team');

-- Remove all Stripe subscription records
DELETE FROM "subscriptions";

-- Clear webhook events (they reference old Stripe account)
DELETE FROM "webhook_events";
