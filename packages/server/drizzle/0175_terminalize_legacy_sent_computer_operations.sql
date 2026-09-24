-- 0174 preserved pending legacy operations as same-UUID dispatch children.
-- Unsent rows can be claimed by the new dispatcher, but rows whose historical
-- command was already sent can only replay the old ready acknowledgement. That
-- shape lacks the machine-attestation evidence required by the new reducer, so
-- close only that bounded cohort honestly instead of waiting for its deadline.
WITH "terminalized_legacy_parents" AS (
	UPDATE "computer_lifecycle_operations" AS "operation"
	SET
		"status" = 'unconfirmed',
		"terminal_at" = now(),
		"terminal_reason" = 'legacy_sent_operation_missing_machine_attestation'
	FROM "computer_lifecycle_dispatches" AS "dispatch"
	WHERE
		"dispatch"."parent_operation_id" = "operation"."id"
		AND "dispatch"."adapter" = 'legacy_pending_server_operation_v1'
		AND "dispatch"."terminal_at" IS NULL
		AND "operation"."status" = 'pending'
		AND "operation"."terminal_at" IS NULL
		AND "operation"."dispatch_status" = 'sent'
	RETURNING "operation"."id", "operation"."terminal_at"
)
UPDATE "computer_lifecycle_dispatches" AS "dispatch"
SET
	"phase" = 'finalized',
	"phase_version" = "dispatch"."phase_version" + 1,
	"failure_code" = 'legacy_sent_operation_missing_machine_attestation',
	"updated_at" = "terminalized"."terminal_at",
	"terminal_at" = "terminalized"."terminal_at"
FROM "terminalized_legacy_parents" AS "terminalized"
WHERE
	"dispatch"."parent_operation_id" = "terminalized"."id"
	AND "dispatch"."adapter" = 'legacy_pending_server_operation_v1'
	AND "dispatch"."terminal_at" IS NULL;
