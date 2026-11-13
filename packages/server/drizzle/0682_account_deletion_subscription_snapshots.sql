SET LOCAL lock_timeout = '2s';
ALTER TABLE "account_deletion_requests" ADD COLUMN "cancelled_subscription_snapshots" jsonb;