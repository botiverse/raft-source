-- Every Guest has its channel (#wg-rbac:#48, Tenny), step 1 of 2: add
-- server_members_guest_has_channel NOT VALID.
--   role <> 'guest' OR guest_channel_id IS NOT NULL
-- A Guest belongs to exactly one channel of its server, bound when it accepts
-- an external invite (#wg-rbac:#15); server_members_guest_channel_only_for_guest
-- (0511) is the converse.
--
-- Safe for the serving and rollback images (docs/operations/server-release.md):
-- no release from v1.21.58 on writes a Guest without a channel. A Member can't be
-- made a Guest (transitionMemberRole refuses), stored Guest server invites are
-- refused on accept, public join-as-guest is a 404 stub, and external invite
-- accept binds the channel in the same insert. Production had 0 rows that would
-- violate it (replica check, Tenny).
--
-- NOT VALID: a catalog-only change that scans nothing; it checks every insert
-- and update from now on. The next release validates it in a migration of its
-- own (SHARE UPDATE EXCLUSIVE, writes keep going) once this is the oldest
-- image (step 2). Locks: ACCESS EXCLUSIVE on server_members, a hot table, for
-- the catalog change only: wait at most 2 s (the deploy retries) and do nothing
-- else in this transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_guest_has_channel" CHECK ("server_members"."role" <> 'guest' OR "server_members"."guest_channel_id" IS NOT NULL) NOT VALID;
