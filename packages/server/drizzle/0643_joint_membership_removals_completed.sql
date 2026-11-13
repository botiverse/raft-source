-- joint_membership_removals: who a joint disconnect removed. Rows were deleted
-- as soon as the departure's cleanup finished, so that was lost; now each row
-- is marked completed_at once its removal and revocation are done, and the
-- hourly maintenance deletes it 90 days after its departure completed
-- (jointMembershipRemovalRetention.ts). Every pending-removal read goes through
-- joint_membership_departures.completed_at IS NULL, so a kept row denies nobody.
--
-- A nullable column with no default: catalog-only. No index: the table holds
-- only these 90 days of disconnect history (until now no row outlived its
-- departure's cleanup), which the hourly retention reads in full. Older server
-- code never names the column and keeps deleting the rows it finishes.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "joint_membership_removals" ADD COLUMN "completed_at" timestamp with time zone;
