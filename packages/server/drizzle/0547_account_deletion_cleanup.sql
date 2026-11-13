-- Account deletion cleanup (services/accountDeletion/cleanup.ts; design "删除账号：服务端设计 v2" §7):
--   account_deletion_requests.account_retired_at   the first phase (one
--                              transaction: ownership handed over, account
--                              retired and scrubbed) is done; the request
--                              stays pending until the second phase (the
--                              person's data, in bounded batches) finishes.
--   account_deletion_requests.cleanup_lease_until  the second phase's lease,
--                              so one replica works on a request at a time.
--   account_deletion_requests.cancelled_subscription_server_ids  the servers
--                              whose subscription the request set to cancel at
--                              period end; cancelling the request resumes them.
--   user_retirement_receipts.server_handoffs  what became of each server the
--                              person owned (who was made owner, or deleted).
--   user_retirement_receipts.agent_dispositions  what became of each of the
--                              person's agents (handed to the server owner,
--                              archived, or left as it was).
--
-- Nullable columns with no default: catalog-only changes, no rewrite or scan.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "account_retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "cleanup_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "cancelled_subscription_server_ids" jsonb;--> statement-breakpoint
ALTER TABLE "user_retirement_receipts" ADD COLUMN "server_handoffs" jsonb;--> statement-breakpoint
ALTER TABLE "user_retirement_receipts" ADD COLUMN "agent_dispositions" jsonb;