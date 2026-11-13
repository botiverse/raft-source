-- Indexes on CDC source tables and on the totals view that no other file here
-- creates. The reads they serve return the same rows without them, but as full
-- scans.
--
-- Every statement is IF NOT EXISTS, so the file is a no-op on a cluster that
-- already has them. Apply it on any cluster after its CDC tables exist,
-- together with 024's CDC-table indexes (idx_rw_message_mentions_v2_inbox,
-- idx_rw_messages_channel_seq, ...) and 061's
-- idx_rw_inbox_target_mute_states_v2_receiver: recreating the CDC tables does
-- not bring any of them back.
--
-- Not in the local bootstrap (RISINGWAVE_BOOTSTRAP_ARTIFACTS): they change how
-- fast a read is, not what it returns, and rw_read_mutation_authorities_v1 is
-- not one of its tables.
--
-- An index added by hand on a running cluster belongs in a file here in the
-- same change. Comparing two clusters' rw_catalog.rw_indexes lists finds one
-- that is missing on either side.

CREATE INDEX IF NOT EXISTS idx_rw_messages_channel_created_seq
  ON rw_messages (channel_id, created_at, seq);

CREATE INDEX IF NOT EXISTS idx_rw_inbox_target_mute_states_v2_source
  ON rw_inbox_target_mute_states_v2 (source_channel_id);

CREATE INDEX IF NOT EXISTS idx_rw_server_members_server_joined
  ON rw_server_members (server_id, joined_at);

CREATE INDEX IF NOT EXISTS idx_rw_server_members_user_joined
  ON rw_server_members (user_id, joined_at);

CREATE INDEX IF NOT EXISTS idx_rw_read_mutation_authorities_v1_principal
  ON rw_read_mutation_authorities_v1 (server_id, principal_id);

CREATE INDEX IF NOT EXISTS idx_rw_user_channel_read_cursors_v2_user
  ON rw_user_channel_read_cursors_v2 (user_id, channel_id);

-- getActivityUnreadTotalsBatch (channelService.ts, the "point lookup on the
-- totals MV" of /api/servers/unread-summary and the mobile push badge) filters
-- on receiver_type, receiver_id and server_id. The view's primary key is its
-- hidden join columns, so without this index every read scans the whole view.
-- On a cluster with real data, build it with backfill_rate_limit and
-- enable_locality_backfill = false.
CREATE INDEX IF NOT EXISTS idx_rw_activity_totals_v7_receiver
  ON rw_activity_totals_v7 (receiver_type, receiver_id, server_id)
  INCLUDE (total_unread_count);
