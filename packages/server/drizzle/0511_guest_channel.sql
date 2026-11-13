-- Guest + external channels P1 (#wg-rbac:#15): a Guest belongs to exactly one
-- channel of its server, recorded on its server_members row. Only accepting an
-- external invite (P2) will set it; nothing writes it yet.
--
-- Lock budget: the FK takes SHARE ROW EXCLUSIVE on channels (377 MB, hot), so
-- fail fast (the deploy retries) and add it NOT VALID (no scan under that lock),
-- then validate under the lighter SHARE UPDATE EXCLUSIVE. The new column is all
-- NULL, so the validation finds nothing to check. No ON DELETE action: channels
-- are soft-deleted, and a channel's delete or archive path ends its Guest's
-- access itself (audit, socket revocation, channel_humans cleanup).
--
-- server_members is small (18 MB): the partial index is built directly, and the
-- CHECK (a binding only on a Guest) holds for every existing row because the
-- column is all NULL. Its converse, every Guest has a binding, is added NOT
-- VALID with the access rules; production has no Guest rows (Tenny, replica,
-- 2026-10-30).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "guest_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_guest_channel_id_channels_id_fk" FOREIGN KEY ("guest_channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "server_members" VALIDATE CONSTRAINT "server_members_guest_channel_id_channels_id_fk";--> statement-breakpoint
CREATE INDEX "idx_server_members_guest_channel" ON "server_members" USING btree ("guest_channel_id") WHERE guest_channel_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_guest_channel_only_for_guest" CHECK ("server_members"."guest_channel_id" IS NULL OR "server_members"."role" = 'guest');
