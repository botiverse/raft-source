-- rw_chat_watermark_v1: one-row source-to-RisingWave watermark, for a job
-- outside the server that reports how far RisingWave is behind Postgres.
--
-- Such a job samples the RW watermark repeatedly with
--   select max(seq), max(created_at) from rw_messages
--   where message_type = 'chat' and sender_type in ('user', 'agent')
-- rw_messages has no index leading on seq or created_at, so every sample is a
-- full scan of the message table. This view keeps the same values with the
-- same filter, so each sample reads one row.
--
-- Semantics: the view advances on the next barrier, so the watermark it reports
-- is about 1 s older than a direct read of rw_messages.
-- chat_rows is for checking only.
--
-- Not in the local bootstrap (RISINGWAVE_BOOTSTRAP_ARTIFACTS): the server does
-- not read it.
--
-- Apply (RW 3.1), with the session settings below:
--   - streaming_parallelism 8: a fixed cap, so the backfill does not occupy
--     every core.
--   - enable_locality_backfill false: 3.1 otherwise adds permanent
--     LOCALITY_PROVIDER fragments for a large-table backfill.
--   - backfill_rate_limit is rows/s per backfill actor: start at 1000 and,
--     once the cluster is steady, raise it with ALTER MATERIALIZED VIEW
--     rw_chat_watermark_v1 SET BACKFILL_RATE_LIMIT = 2000.
--     Lower it if barrier p50 exceeds 5 s or rw_messages falls more than 30 s
--     behind.
-- After it is created (with background_ddl the new compaction group exists as
-- soon as the backfill starts, so do this first):
--   ALTER COMPACTION GROUP <new id> SET disable_auto_group_scheduling = true;
--   ALTER MATERIALIZED VIEW rw_chat_watermark_v1 OWNER TO <app role>;
--   GRANT SELECT ON MATERIALIZED VIEW rw_chat_watermark_v1 TO <reader role>;
-- RisingWave needs ON MATERIALIZED VIEW in the GRANT; `GRANT SELECT ON
-- rw_chat_watermark_v1` fails with "is not a table". Give the reader role no
-- grant on rw_messages, so a missing view makes the job fail rather than scan.
-- Check max_seq against Postgres: max_seq equal and max_created_at within a
-- few seconds.

SET streaming_parallelism = 8;
SET enable_locality_backfill = false;
SET backfill_rate_limit = 1000;
SET background_ddl = true;

CREATE MATERIALIZED VIEW IF NOT EXISTS rw_chat_watermark_v1 AS
SELECT
  max(seq) AS max_seq,
  max(created_at) AS max_created_at,
  count(*) AS chat_rows
FROM rw_messages
WHERE message_type = 'chat'
  AND sender_type IN ('user', 'agent');
