SET LOCAL lock_timeout = '2s';
ALTER TABLE "account_deletion_requests" ADD COLUMN "subscription_restoration_results" jsonb;