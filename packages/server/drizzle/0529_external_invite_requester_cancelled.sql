-- Guest + external channels follow-ups (#wg-rbac:#16): the invitee may
-- withdraw their own pending request for a server owner/admin to approve
-- connecting it (POST /api/external-invites/:token/cancel-request, behind
-- external_channels_v1). Such a request ends cancelled with cancel_reason
-- 'requester_cancelled'; the CHECK listing the known reasons gains it.
--
-- Lock budget: channel_server_connect_requests is new and nearly empty in
-- production (external_channels_v1 is off), so re-adding the CHECK scans it
-- instantly under a brief ACCESS EXCLUSIVE lock; fail fast instead of
-- queueing writers behind the DDL (the deploy retries).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" DROP CONSTRAINT "channel_server_connect_requests_cancel_reason_known";--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_cancel_reason_known" CHECK ("channel_server_connect_requests"."cancel_reason" IS NULL OR "channel_server_connect_requests"."cancel_reason" IN ('approver_lost_role', 'requester_left', 'invite_revoked', 'requester_cancelled'));
