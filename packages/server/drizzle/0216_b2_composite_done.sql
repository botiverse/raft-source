-- Gate B2 composite Done metadata. Both columns are nullable and born in their
-- final storage domains; the existing RFC 057 int4 cursor authority is not
-- widened or reinterpreted here.
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "read_mutations" DROP CONSTRAINT "read_mutations_scope_shape";--> statement-breakpoint
ALTER TABLE "read_mutations" ADD COLUMN "done_target_kind" text;--> statement-breakpoint
ALTER TABLE "read_mutations" ADD COLUMN "done_through_seq" bigint;--> statement-breakpoint
ALTER TABLE "read_mutations" ADD CONSTRAINT "read_mutations_scope_shape" CHECK (
    ("read_mutations"."kind" = 'global_read_all' AND "read_mutations"."scope_id" IS NULL AND "read_mutations"."requested_through_seq" IS NULL AND "read_mutations"."done_target_kind" IS NULL AND "read_mutations"."done_through_seq" IS NULL)
    OR ("read_mutations"."kind" = 'channel_read_all' AND "read_mutations"."scope_id" IS NOT NULL AND "read_mutations"."requested_through_seq" IS NULL AND "read_mutations"."done_target_kind" IS NULL AND "read_mutations"."done_through_seq" IS NULL)
    OR ("read_mutations"."kind" IN ('row_read', 'row_unread') AND "read_mutations"."scope_id" IS NOT NULL AND "read_mutations"."requested_through_seq" IS NOT NULL AND "read_mutations"."requested_through_seq" >= 0 AND "read_mutations"."done_target_kind" IS NULL AND "read_mutations"."done_through_seq" IS NULL)
    OR ("read_mutations"."kind" = 'done' AND "read_mutations"."scope_id" IS NOT NULL AND "read_mutations"."requested_through_seq" IS NULL AND "read_mutations"."done_target_kind" IN ('channel', 'thread') AND "read_mutations"."done_through_seq" IS NOT NULL AND "read_mutations"."done_through_seq" > 0)
  ) NOT VALID;
-- The replaced constraint is a strict superset of the previously validated
-- shape for every legacy kind, and NOT VALID still enforces it for all new or
-- updated rows (including `done`). Keep validation out of this deploy
-- transaction so a historical-table scan cannot retain the brief
-- ACCESS EXCLUSIVE lock acquired by the preceding metadata-only ALTERs.
