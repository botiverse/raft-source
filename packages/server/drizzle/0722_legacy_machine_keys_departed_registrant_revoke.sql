-- #wg-rbac:#78: legacy machine keys (`sk_machine_*`) whose registrant is no
-- longer a member of the machine's server, or only a Guest, are revoked once,
-- with every live runner credential those machines minted. From this release
-- on, ending a membership revokes them (serverService executeMemberRemoval)
-- and legacy-key sign-in refuses a departed registrant
-- (lib/legacyMachineKeyStanding.ts). But a runner credential minted before the
-- registrant left is checked only against its agent's machine and its expiry,
-- so the ones already minted would stay live without this.
--
-- The same machines revokeLegacyMachineKeysOfDepartingRegistrant reaches: no
-- `computers` row, never migrated, not already revoked; on a live server.
-- Each is audited as the removal path audits it (`computer.key_revoked`,
-- target `machine`; `agent_credential.revoked`), by the system, `trigger`
-- `repair`. Production: 6 such machines on 6 servers (read-only count,
-- 2026-11-16 05:1xZ, Tenny); none connected in the last 7 days. Their live
-- daemon connections, if any, are refused at the next reconnect.
--
-- Locks: ROW EXCLUSIVE on daemons, agent_credentials and
-- integration_audit_events, as any UPDATE/INSERT; the WHERE reads daemons once
-- (one row per machine) and agent_credentials through
-- issued_by_machine_id's index.
--
-- schema-snapshot: unchanged (data only)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '10min';--> statement-breakpoint
WITH orphaned AS (
  UPDATE "daemons" d SET "api_key_hash" = 'revoked:registrant_left_server'
   WHERE d."legacy_key_migrated_at" IS NULL
     AND d."api_key_hash" NOT LIKE 'revoked:%'
     AND NOT EXISTS (SELECT 1 FROM "computers" c WHERE c."machine_id" = d."id")
     AND EXISTS (SELECT 1 FROM "servers" s WHERE s."id" = d."server_id" AND s."deleted_at" IS NULL)
     AND NOT EXISTS (
       SELECT 1 FROM "server_members" m
        WHERE m."server_id" = d."server_id" AND m."user_id" = d."user_id" AND m."role" <> 'guest'
     )
  RETURNING d."id", d."server_id", d."user_id", d."name"
), creds AS (
  UPDATE "agent_credentials" a SET "revoked_at" = now(), "revoked_reason" = 'computer_key_revoked'
    FROM orphaned o
   WHERE a."issued_by_machine_id" = o."id" AND a."revoked_at" IS NULL
  RETURNING a."id", a."agent_id", o."id" AS "machine_id", o."server_id", o."user_id"
), machine_audit AS (
  INSERT INTO "integration_audit_events"
    ("id", "server_id", "event_type", "event_category", "outcome", "source", "actor_type", "requester_type", "requester_id", "target_type", "target_id", "metadata")
  SELECT gen_random_uuid(), o."server_id", 'computer.key_revoked', 'computer', 'success', 'system', 'system', 'human', o."user_id", 'machine', o."id",
         jsonb_build_object(
           'machineId', o."id", 'computerName', o."name", 'reason', 'computer_key_revoked', 'via', 'member_removed', 'trigger', 'repair',
           'revokedCount', (SELECT count(*) FROM creds c WHERE c."machine_id" = o."id"))
    FROM orphaned o
  RETURNING 1
)
INSERT INTO "integration_audit_events"
  ("id", "server_id", "event_type", "event_category", "outcome", "source", "actor_type", "requester_type", "requester_id", "target_type", "target_id", "metadata")
SELECT gen_random_uuid(), c."server_id", 'agent_credential.revoked', 'agent_credential', 'success', 'system', 'system', 'human', c."user_id", 'agent_credential', c."id",
       jsonb_build_object('agentId', c."agent_id", 'credentialId', c."id", 'reason', 'computer_key_revoked', 'via', 'member_removed', 'trigger', 'repair')
  FROM creds c;
