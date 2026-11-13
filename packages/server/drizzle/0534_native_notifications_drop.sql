-- Unified notifications, contract step 1 (see notification_outbox_contract).
-- This one: RFC 052's native desktop notification store (migration
-- fresh_madripoor), superseded by the unified dispatcher's desktop socket
-- transport. No binary from v1.21.43 on reads or writes it (v1.21.43 still
-- declares the tables in schema.ts but no query names them), so they can go
-- while v1.21.43 runs beside this release and stays its rollback image.
--
-- Locks. Dropping a table drops its foreign keys, and with them the RI
-- triggers on the referenced tables, so the drops take ACCESS EXCLUSIVE on
-- users, servers and session_families too, not only on the four tables. They
-- are all taken up front in one LOCK TABLE, in a fixed order with the hottest
-- table, users, last: users is held only once everything else is, and the
-- drops after it wait for nothing. A busy table makes the migration fail
-- after lock_timeout (2s, not the deploy's 5s: while LOCK TABLE waits for
-- users it already holds servers and session_families, and the API queues
-- behind them), and the deploy is retried; it never stalls auth for longer.
-- Everything after the LOCK is catalog-only.
--
-- In foreign-key order (credentials name devices), no CASCADE: anything else
-- depending on these tables stops the migration instead of being dropped
-- silently. Their indexes, constraints and the stream_seq sequence (owned by
-- its bigserial column) go with them. A table that is already gone is named
-- in a NOTICE (nothing to contract), never skipped silently.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
DECLARE
  native text[] := ARRAY[
    'native_notification_events',
    'native_notification_credentials',
    'native_notification_devices',
    'native_notification_enrollment_grants'
  ];
  present text[];
  t text;
BEGIN
  SELECT coalesce(array_agg(n ORDER BY i), ARRAY[]::text[]) INTO present
    FROM unnest(native) WITH ORDINALITY AS u(n, i)
   WHERE to_regclass('public.' || quote_ident(n)) IS NOT NULL;
  IF cardinality(present) = 0 THEN
    RAISE NOTICE 'native_notifications_drop: no native_notification_* table exists; nothing to drop';
    RETURN;
  END IF;
  EXECUTE 'LOCK TABLE '
    || (SELECT string_agg(format('%I', n), ', ' ORDER BY i) FROM unnest(present) WITH ORDINALITY AS u(n, i))
    || ', "session_families", "servers", "users" IN ACCESS EXCLUSIVE MODE';
  FOREACH t IN ARRAY native LOOP
    IF t = ANY (present) THEN
      EXECUTE format('DROP TABLE %I', t);
    ELSE
      RAISE NOTICE 'native_notifications_drop: % does not exist; nothing to drop', t;
    END IF;
  END LOOP;
END
$$;
