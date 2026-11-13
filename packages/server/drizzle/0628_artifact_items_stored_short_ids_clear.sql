-- schema-snapshot: unchanged (data only: no DDL)
-- An Artifact stored with its short id as its name goes back to no name (task
-- #proj-workspace:#159, Tenny): v1.21.50 to v1.21.56 stored new ones that way
-- for v1.21.49's sake, and from this release they store NULL.
--
-- Only where the name is the row's own short id (encodeArtifactShortId: the
-- uuid's 16 bytes in Base58, 22 characters, left-padded with "1"). An old name
-- is never touched, even one that reads as a short id: it would be another
-- Artifact's, or nobody's. Deleted and revoked rows too: a restore reads the
-- name. Worked out here because Postgres has no Base58; numeric is exact.
--
-- Nothing depends on it. legacyNameOf sends the same short id for NULL, an id
-- is read before a title or a name, and v1.21.55 and v1.21.56 both do that, so
-- a rollback reads these rows as before and a row left behind reads the same.
-- That is why this may stop short:
-- - FOR NO KEY UPDATE SKIP LOCKED: a row a write holds is left as it is, not
--   waited on, and a foreign key's check on a row held here is not blocked.
-- - At most 10000 rows. Expected well under that: only Artifacts made since
--   v1.21.50 (2026-11-04). A file is one transaction, so batches inside it
--   would release nothing: the limit on rows is what keeps it inside the
--   default 30 s transaction_timeout (estimated under 1 ms a row, not
--   measured).
-- - At most 10 seconds: past that the loop stops and commits what it cleared,
--   so a slow run never fails the deploy over a cleanup that reads the same
--   either way. statement_timeout stays as the last resort, a plain error
--   that rolls back. A later run of the same update clears what is left,
--   should anyone want it.
-- Each cleared row's indexes are touched once (name is indexed, so not HOT).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '20s';--> statement-breakpoint
DO $$
DECLARE
  alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  candidate record;
  hex text;
  rest numeric;
  short_id text;
  seen integer := 0;
  cleared integer := 0;
BEGIN
  FOR candidate IN
    SELECT "id", "name" FROM "app_artifacts"."items"
    WHERE "name" ~ '^[1-9A-HJ-NP-Za-km-z]{22}$'
      AND "id" ~ '^pt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    LIMIT 10000
    FOR NO KEY UPDATE SKIP LOCKED
  LOOP
    EXIT WHEN clock_timestamp() - statement_timestamp() > interval '10 seconds';
    seen := seen + 1;
    hex := replace(substr(candidate."id", 4), '-', '');
    rest := 0;
    FOR digit IN 1..32 LOOP
      rest := rest * 16 + strpos('0123456789abcdef', substr(hex, digit, 1)) - 1;
    END LOOP;
    short_id := '';
    FOR digit IN 1..22 LOOP
      short_id := substr(alphabet, (rest % 58)::integer + 1, 1) || short_id;
      rest := div(rest, 58);
    END LOOP;
    IF short_id = candidate."name" THEN
      UPDATE "app_artifacts"."items" SET "name" = NULL WHERE "id" = candidate."id";
      cleared := cleared + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'artifact short id names: % read, % cleared', seen, cleared;
END
$$;
