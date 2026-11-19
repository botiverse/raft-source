-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE TABLE rw_joint_entry_server_members_v1 (server_id varchar, user_id varchar, role varchar, guest_channel_id varchar, joined_at timestamptz, PRIMARY KEY (server_id,user_id))
FROM slock_neon_cdc TABLE 'public.server_members';
