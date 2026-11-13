import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0400 adds NOT NULL columns without a default to link_card_operations, so it
// first clears the link_card_* tables (nothing writes them in production yet).
// A leftover row in any of them must not stop a deploy at this migration.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0400_link_card_operation_send_target";

function statements(sqlText: string): string[] {
  return sqlText.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

async function applyBefore(client: PGlite, tag: string): Promise<void> {
  const journal = JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const target = journal.entries.find((entry) => entry.tag === tag);
  assert.ok(target, `${tag} is in the journal`);
  await client.exec("BEGIN");
  try {
    for (const entry of journal.entries.filter((candidate) => candidate.idx < target.idx)) {
      for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"))) await client.exec(statement);
    }
    await client.exec("COMMIT");
  } catch (error) {
    await client.exec("ROLLBACK");
    throw error;
  }
}

const SERVER = "00000000-0000-4000-8000-0000000000b1";
const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const OPERATION = "00000000-0000-4000-8000-0000000000d1";
const DOMAIN = `'native', 'workspace', 'native:${SERVER}:workspace'`;
const LINK_CARD_TABLES = ["link_card_views", "link_card_update_tokens", "link_card_attempts", "link_card_handle_uses",
  "link_card_client_requests", "link_card_prepared_actions", "link_card_operations"];

test("0400 applies with leftover rows in every link_card table, and leaves them empty", { timeout: 300_000 }, async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO link_card_operations (operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key, registration_revision, view_nonce, message_id, action_id, request_sha256, state)
        VALUES ('${OPERATION}', '${VIEWER}', '${SERVER}', ${DOMAIN}, 'native', 'n1', '00000000-0000-4000-8000-0000000000e1', 'share', '${"r".repeat(64)}', 'unknown');
      INSERT INTO link_card_client_requests (viewer_id, server_id, provider_kind, provider_key, installation_key, client_request_id, operation_id, url_sha256, action_id, request_sha256)
        VALUES ('${VIEWER}', '${SERVER}', ${DOMAIN}, '${"c".repeat(32)}', '${OPERATION}', '${"u".repeat(64)}', 'share', '${"r".repeat(64)}');
      INSERT INTO link_card_handle_uses (handle_sha256, operation_id, expires_at) VALUES ('${"h".repeat(64)}', '${OPERATION}', now() + interval '10 minutes');
      INSERT INTO link_card_attempts (jti, viewer_id, server_id, provider_kind, provider_key, installation_key, operation_id, phase)
        VALUES ('00000000-0000-4000-8000-0000000000f1', '${VIEWER}', '${SERVER}', ${DOMAIN}, '${OPERATION}', 'execute');
      INSERT INTO link_card_prepared_actions (prepared_action_id, viewer_id, server_id, provider_kind, provider_key, installation_key, view_nonce, handle_sha256, description_sha256, business_revision, read_at, expires_at, consumed_by_operation_id)
        VALUES ('00000000-0000-4000-8000-0000000000f2', '${VIEWER}', '${SERVER}', ${DOMAIN}, 'n1', '${"p".repeat(64)}', '${"s".repeat(64)}', 'br', now(), now() + interval '5 minutes', '${OPERATION}');
      INSERT INTO link_card_update_tokens (token_sha256, operation_id, server_id, provider_kind, provider_key, installation_key, registration_revision, expires_at)
        VALUES ('${"t".repeat(64)}', '${OPERATION}', '${SERVER}', ${DOMAIN}, 'native', now() + interval '10 minutes');
      INSERT INTO link_card_views (view_nonce, view_instance_id, viewer_id, server_id, provider_kind, provider_key, installation_key, message_id, url_sha256, pending_operation_id)
        VALUES ('n1', 'v1', '${VIEWER}', '${SERVER}', ${DOMAIN}, '00000000-0000-4000-8000-0000000000e1', '${"u".repeat(64)}', '${OPERATION}');
    `);
    for (const table of LINK_CARD_TABLES) {
      assert.equal(Number((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n), 1, `${table} seeded`);
    }

    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);

    for (const table of LINK_CARD_TABLES) {
      assert.equal(Number((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n), 0, `${table} cleared`);
    }
    const columns = (await client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'link_card_operations' AND column_name IN ('url_sha256', 'first_send_deadline') ORDER BY column_name",
    )).rows;
    assert.deepEqual(columns, [{ column_name: "first_send_deadline", is_nullable: "NO" }, { column_name: "url_sha256", is_nullable: "NO" }]);
  } finally {
    await client.close();
  }
});
