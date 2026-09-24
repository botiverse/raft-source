import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyThrough(client: PGlite, lastIndex: number): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of journal.entries.filter((candidate) => candidate.idx <= lastIndex)) {
    const migration = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    for (const statement of statements(migration)) await client.exec(statement);
  }
}

test("0174 backfills legacy dispatches and 0175 honestly closes only the already-sent cohort", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 172);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'migration@example.com', 'migration-user', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'migration-server', 'migration-server', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "computer_lifecycle_operations" (
        "id", "server_id", "computer_id", "machine_id", "action", "cause",
        "actor_user_id", "status", "dispatch_mode", "created_at"
      ) VALUES
        (
          '33333333-3333-4333-8333-333333333333',
          '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
          'restart', 'user_action', '11111111-1111-4111-8111-111111111111',
          'pending', 'server', '2026-07-13T00:00:00.000Z'
        ),
        (
          '66666666-6666-4666-8666-666666666666',
          '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
          'upgrade', 'user_action', '11111111-1111-4111-8111-111111111111',
          'pending', 'server', '2026-07-13T00:00:01.000Z'
        ),
        (
          '77777777-7777-4777-8777-777777777777',
          '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4444-8444-444444444447',
          '55555555-5555-4555-8555-555555555557',
          'upgrade', 'user_action', '11111111-1111-4111-8111-111111111111',
          'pending', 'server', '2026-07-13T00:00:02.000Z'
        );
      UPDATE "computer_lifecycle_operations"
      SET "dispatch_status" = 'sent'
      WHERE "id" = '77777777-7777-4777-8777-777777777777';
    `);

    const migration = await readFile(path.join(DRIZZLE_DIR, "0174_steady_silvermane.sql"), "utf8");
    for (const statement of statements(migration)) await client.exec(statement);

    const operations = await client.query<{
      id: string;
      status: string;
      terminal_at: string | null;
      terminal_reason: string | null;
    }>(`
      SELECT "id", "status", "terminal_at", "terminal_reason"
      FROM "computer_lifecycle_operations"
      ORDER BY "created_at", "id"
    `);
    assert.equal(operations.rows[0]?.status, "pending");
    assert.equal(operations.rows[0]?.terminal_at, null);
    assert.equal(operations.rows[1]?.status, "superseded");
    assert.ok(operations.rows[1]?.terminal_at);
    assert.equal(operations.rows[1]?.terminal_reason, "superseded_by_machine_serialization_schema");
    assert.equal(operations.rows[2]?.status, "pending");
    assert.equal(operations.rows[2]?.terminal_at, null);

    const dispatches = await client.query<{
      id: string;
      parent_operation_id: string;
      dispatch_action: string;
      target_version: string;
      adapter: string;
      phase: string;
      failure_code: string | null;
      terminal_at: string | null;
    }>(`
      SELECT "id", "parent_operation_id", "dispatch_action", "target_version", "adapter",
        "phase", "failure_code", "terminal_at"
      FROM "computer_lifecycle_dispatches"
      ORDER BY "id"
    `);
    assert.deepEqual(dispatches.rows, [
      {
        id: "33333333-3333-4333-8333-333333333333",
        parent_operation_id: "33333333-3333-4333-8333-333333333333",
        dispatch_action: "restart",
        target_version: "0.72.9",
        adapter: "legacy_pending_server_operation_v1",
        phase: "accepted",
        failure_code: null,
        terminal_at: null,
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        parent_operation_id: "77777777-7777-4777-8777-777777777777",
        dispatch_action: "upgrade",
        target_version: "0.72.9",
        adapter: "legacy_pending_server_operation_v1",
        phase: "accepted",
        failure_code: null,
        terminal_at: null,
      },
    ], "0174 must backfill both unsent and already-sent legacy operations");

    await assert.rejects(
      client.exec(`
        INSERT INTO "computer_lifecycle_operations" (
          "id", "server_id", "computer_id", "machine_id", "action", "cause",
          "actor_user_id", "status", "dispatch_mode", "created_at"
        ) VALUES (
          'aaaaaaaa-7777-4777-8777-777777777777',
          '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
          'upgrade', 'user_action', '11111111-1111-4111-8111-111111111111',
          'pending', 'server', '2026-07-13T00:00:02.000Z'
        )
      `),
      /idx_computer_lifecycle_operations_one_pending_machine/,
    );

    const terminalization = await readFile(
      path.join(DRIZZLE_DIR, "0175_terminalize_legacy_sent_computer_operations.sql"),
      "utf8",
    );
    for (const statement of statements(terminalization)) await client.exec(statement);

    const postTerminalizationOperations = await client.query<{
      id: string;
      status: string;
      terminal_at: string | null;
      terminal_reason: string | null;
    }>(`
      SELECT "id", "status", "terminal_at", "terminal_reason"
      FROM "computer_lifecycle_operations"
      WHERE "id" IN (
        '33333333-3333-4333-8333-333333333333',
        '77777777-7777-4777-8777-777777777777'
      )
      ORDER BY "id"
    `);
    assert.deepEqual(postTerminalizationOperations.rows[0], {
      id: "33333333-3333-4333-8333-333333333333",
      status: "pending",
      terminal_at: null,
      terminal_reason: null,
    }, "an unsent legacy backfill must remain claimable");
    assert.equal(postTerminalizationOperations.rows[1]?.status, "unconfirmed");
    assert.ok(postTerminalizationOperations.rows[1]?.terminal_at);
    assert.equal(
      postTerminalizationOperations.rows[1]?.terminal_reason,
      "legacy_sent_operation_missing_machine_attestation",
    );

    const postTerminalizationDispatches = await client.query<{
      id: string;
      phase: string;
      phase_version: number;
      failure_code: string | null;
      terminal_at: string | null;
    }>(`
      SELECT "id", "phase", "phase_version", "failure_code", "terminal_at"
      FROM "computer_lifecycle_dispatches"
      ORDER BY "id"
    `);
    assert.deepEqual(postTerminalizationDispatches.rows[0], {
      id: "33333333-3333-4333-8333-333333333333",
      phase: "accepted",
      phase_version: 0,
      failure_code: null,
      terminal_at: null,
    });
    assert.equal(postTerminalizationDispatches.rows[1]?.phase, "finalized");
    assert.equal(postTerminalizationDispatches.rows[1]?.phase_version, 1);
    assert.equal(
      postTerminalizationDispatches.rows[1]?.failure_code,
      "legacy_sent_operation_missing_machine_attestation",
    );
    assert.equal(
      String(postTerminalizationDispatches.rows[1]?.terminal_at),
      String(postTerminalizationOperations.rows[1]?.terminal_at),
      "parent and dispatch must close at the same migration timestamp",
    );

    await client.exec(`
      INSERT INTO "computer_lifecycle_operations" (
        "id", "parent_operation_id", "server_id", "computer_id", "machine_id", "action", "cause",
        "actor_user_id", "status", "dispatch_mode", "created_at"
      ) VALUES
        (
          '88888888-8888-4888-8888-888888888881', '99999999-9999-4999-8999-999999999999',
          '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555', 'start', 'user_action',
          '11111111-1111-4111-8111-111111111111', 'pending', 'local', '2026-07-13T00:00:03.000Z'
        ),
        (
          '88888888-8888-4888-8888-888888888882', '99999999-9999-4999-8999-999999999999',
          '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555', 'stop', 'user_action',
          '11111111-1111-4111-8111-111111111111', 'pending', 'local', '2026-07-13T00:00:04.000Z'
        ),
        (
          '88888888-8888-4888-8888-888888888883', '99999999-9999-4999-8999-999999999999',
          '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555', 'restart', 'user_action',
          '11111111-1111-4111-8111-111111111111', 'pending', 'local', '2026-07-13T00:00:05.000Z'
        ),
        (
          '88888888-8888-4888-8888-888888888884', '99999999-9999-4999-8999-999999999999',
          '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555', 'upgrade', 'user_action',
          '11111111-1111-4111-8111-111111111111', 'pending', 'local', '2026-07-13T00:00:06.000Z'
        );
    `);
  } finally {
    await client.close();
  }
});
