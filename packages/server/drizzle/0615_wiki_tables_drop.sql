-- Retired Wiki, step 6 of 6: drop its five tables. No code reads or writes them since
-- #8221. 0611-0614 already dropped every foreign key from them to servers, channels,
-- agents and users, so this locks only the Wiki tables themselves: the three 0191 tables
-- go first, as they hold the foreign keys into wiki_spaces.
--
-- The drop and its data are authorized by tygg on 2026-11-05: the two tables at
-- 07:35Z, the three 0191 tables at 08:02Z (#raft-architecture:3abfac85;
-- #triage:#207, #triage:#221). Production rows at the time of writing:
-- wiki_artifacts 0, wiki_jobs 608, wiki_source_coverage 158 (records from before
-- the retirement), wiki_bindings 1, wiki_spaces 1. The agents and channels those
-- rows name are not touched here.
--
-- No CASCADE: an unexpected dependent object fails the migration instead of being
-- dropped with it. A no-op where a table is already gone (staging, 0606's first version).
-- The check below finds nothing there either.
--
-- schema-snapshot: unchanged (schema.ts no longer declares the Wiki tables)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- 0611-0614 name each foreign key, and IF EXISTS skips a wrong name in silence. So
-- check first: any foreign key left from a Wiki table to another table fails this
-- migration, rather than letting the drop lock that table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    WHERE c.contype = 'f'
      AND child.relname LIKE 'wiki\_%'
      AND parent.relname NOT LIKE 'wiki\_%'
  ) THEN
    RAISE EXCEPTION 'a Wiki table still has a foreign key to another table: 0611-0614 missed it';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "wiki_artifacts";--> statement-breakpoint
DROP TABLE IF EXISTS "wiki_jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "wiki_source_coverage";--> statement-breakpoint
DROP TABLE IF EXISTS "wiki_bindings";--> statement-breakpoint
DROP TABLE IF EXISTS "wiki_spaces";
