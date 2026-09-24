-- RFC 057 Phase A: read-cursor int4->int8 shadow widen.
--
-- Runs under the SAME migration identity as every other migration in this repo
-- (no custom database roles, no identity gate — owner decision 2026-07-31, since
-- the widen itself needs none, and staging already runs migrations on the
-- isolated migrator seam #5481, not the serving account). Cold objects come
-- first; the three hot tables are pre-locked in ONE NOWAIT statement so there is
-- no hold-while-waiting state. Everything runs inside the deploy migrator's
-- single transaction: any failure rolls back the whole set and the migrator's
-- structured error line names the failing statement.
--
-- S0: fail-fast belts. The explicit hot path (S1) never queues by construction;
-- lock_timeout guards implicit/catalog locks only.
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
-- S1: phase ledger (singleton by CONSTRAINT; drives A/B/C/D fencing). The
-- singleton/epoch/enum invariants are enforced by the CHECKs below regardless of
-- who writes the row.
CREATE TABLE "read_cursor_widen_phase" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"phase" text NOT NULL,
	"epoch" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "read_cursor_widen_phase_singleton" CHECK ("read_cursor_widen_phase"."id"),
	CONSTRAINT "read_cursor_widen_phase_epoch_min" CHECK ("read_cursor_widen_phase"."epoch" >= 1),
	CONSTRAINT "read_cursor_widen_phase_phase_enum" CHECK ("read_cursor_widen_phase"."phase" IN ('shadow_widen', 'backfilling', 'cutover', 'rolled_back', 'retired'))
);
--> statement-breakpoint
-- S2: append-only transition audit.
CREATE TABLE "read_cursor_widen_phase_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"phase_from" text,
	"phase_to" text NOT NULL,
	"epoch" integer NOT NULL,
	"operator" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- S3: seed singleton + audit seed.
INSERT INTO "read_cursor_widen_phase" ("id", "phase", "epoch", "updated_by") VALUES (true, 'shadow_widen', 1, 'migration:0215');--> statement-breakpoint
INSERT INTO "read_cursor_widen_phase_audit" ("phase_from", "phase_to", "epoch", "operator", "note") VALUES (NULL, 'shadow_widen', 1, 'migration:0215', 'RFC057 phase A seed');--> statement-breakpoint
-- S4-S6: forward-only mirror functions (phase A semantics: NEW.seq8 := NEW.seq).
CREATE FUNCTION public.read_cursor_mirror_user_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.last_read_seq8 := NEW.last_read_seq;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.read_cursor_mirror_agent_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.last_read_seq8 := NEW.last_read_seq;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.read_cursor_mirror_mutation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.requested_through_seq8 := NEW.requested_through_seq;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- S7: phase transition helper — validates the frozen forward-only edge set,
-- performs the phase+epoch CAS and writes the audit row atomically. Plain
-- function (no SECURITY DEFINER / role restriction): the operator job calls it
-- under the ordinary migration/operator identity; the edge/CAS logic is the
-- fence, independent of who runs it.
CREATE FUNCTION public.read_cursor_widen_transition(
  expected_phase text,
  expected_epoch integer,
  next_phase text,
  note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_epoch integer;
  updated integer;
BEGIN
  -- Frozen forward-only edge set. rolled_back->backfilling bumps epoch.
  IF NOT (
    (expected_phase = 'shadow_widen' AND next_phase = 'backfilling') OR
    (expected_phase = 'backfilling' AND next_phase = 'cutover') OR
    (expected_phase = 'cutover' AND next_phase = 'rolled_back') OR
    (expected_phase = 'rolled_back' AND next_phase = 'backfilling') OR
    (expected_phase = 'cutover' AND next_phase = 'retired')
  ) THEN
    RAISE EXCEPTION 'read_cursor_widen_transition: illegal edge % -> %', expected_phase, next_phase
      USING ERRCODE = 'check_violation';
  END IF;

  next_epoch := CASE
    WHEN expected_phase = 'rolled_back' AND next_phase = 'backfilling' THEN expected_epoch + 1
    ELSE expected_epoch
  END;

  -- Actor identity is the AUTHENTICATED database principal (session_user), never
  -- a caller-supplied label.
  UPDATE public.read_cursor_widen_phase
     SET phase = next_phase, epoch = next_epoch, updated_at = now(), updated_by = session_user
   WHERE id AND phase = expected_phase AND epoch = expected_epoch;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> 1 THEN
    RAISE EXCEPTION 'read_cursor_widen_transition: CAS failed (expected %/% not current)', expected_phase, expected_epoch
      USING ERRCODE = 'serialization_failure';
  END IF;

  INSERT INTO public.read_cursor_widen_phase_audit (phase_from, phase_to, epoch, operator, note)
  VALUES (expected_phase, next_phase, next_epoch, session_user, note);
END;
$$;--> statement-breakpoint
-- PostgreSQL grants EXECUTE to PUBLIC by default on new functions; revoke it so
-- only the function owner (the migration identity that ran 0215) can advance the
-- phase — no application/serving connection may.
REVOKE EXECUTE ON FUNCTION public.read_cursor_widen_transition(text, integer, text, text) FROM PUBLIC;--> statement-breakpoint
-- S8: single NOWAIT pre-lock of all three hot tables (never queues; any
-- unavailable table errors immediately with 55P03 and the whole transaction —
-- cold objects included — rolls back). Every applier runs the pending set in one
-- transaction, so the locks hold to commit.
LOCK TABLE "user_channel_read_cursors", "agent_channel_read_cursors", "read_mutations" IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
-- S9-S14: the six hot metadata statements (nullable, no default => metadata-only
-- on PG 17; no table rewrite).
ALTER TABLE "user_channel_read_cursors" ADD COLUMN "last_read_seq8" bigint;--> statement-breakpoint
CREATE TRIGGER "read_cursor_mirror_user_trg" BEFORE INSERT OR UPDATE ON "user_channel_read_cursors" FOR EACH ROW EXECUTE FUNCTION public.read_cursor_mirror_user_fn();--> statement-breakpoint
ALTER TABLE "agent_channel_read_cursors" ADD COLUMN "last_read_seq8" bigint;--> statement-breakpoint
CREATE TRIGGER "read_cursor_mirror_agent_trg" BEFORE INSERT OR UPDATE ON "agent_channel_read_cursors" FOR EACH ROW EXECUTE FUNCTION public.read_cursor_mirror_agent_fn();--> statement-breakpoint
ALTER TABLE "read_mutations" ADD COLUMN "requested_through_seq8" bigint;--> statement-breakpoint
CREATE TRIGGER "read_cursor_mirror_mutation_trg" BEFORE INSERT OR UPDATE ON "read_mutations" FOR EACH ROW EXECUTE FUNCTION public.read_cursor_mirror_mutation_fn();
