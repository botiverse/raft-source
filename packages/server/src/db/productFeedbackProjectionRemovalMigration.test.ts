import assert from "node:assert/strict";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migratePglite } from "./pgliteMigrations.js";

const REMOVED_TABLES = [
  "product_feedback_event_digest_conflicts",
  "product_feedback_event_facts",
  "product_feedback_notification_cursors",
  "product_feedback_read_cursors",
  "product_feedback_webhook_security_audits",
] as const;

test("0201 removes every Raft-owned feedback event/read projection table", async () => {
  const client = new PGlite();
  try {
    await migratePglite(client);
    const result = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY (ARRAY[${REMOVED_TABLES.map((name) => `'${name}'`).join(", ")}])
      ORDER BY table_name
    `);
    assert.deepEqual(result.rows, []);

    const retained = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'integration_secret_commitments'
    `);
    assert.deepEqual(retained.rows, [{ table_name: "integration_secret_commitments" }]);
  } finally {
    await client.close();
  }
});
