import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migratePglite } from "./pgliteMigrations.js";

const OUTBOX_MIGRATION = fileURLToPath(
  new URL("../../drizzle/0251_slack_bridge_control_plane.sql", import.meta.url),
);

const FUNCTION_NAMES = [
  "assert_external_delivery_partition_tail_consistent",
  "check_external_delivery_partition_tail_consistent",
] as const;

const TRIGGER_FACTS = [{
  name: "external_delivery_partition_tail_after_delivery",
  table: "external_outbound_deliveries",
}, {
  name: "external_delivery_partition_tail_after_partition",
  table: "external_delivery_partitions",
}] as const;

function extractFunctionBody(sql: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION "${escapedName}"[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  ));
  assert.ok(match?.[1], `missing function body for ${name}`);
  return match[1];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("empty database applies the full migration chain and preserves Slack trigger/function bytes", async () => {
  const client = new PGlite();
  try {
    await migratePglite(client);
    const sql = await readFile(OUTBOX_MIGRATION, "utf8");

    const functions = await client.query<{ name: string; body: string }>(`
      SELECT proname AS name, prosrc AS body
      FROM pg_proc
      WHERE proname = ANY($1::text[])
      ORDER BY proname
    `, [FUNCTION_NAMES]);
    assert.equal(functions.rows.length, FUNCTION_NAMES.length);
    for (const row of functions.rows) {
      const expectedBody = extractFunctionBody(sql, row.name);
      assert.equal(
        sha256(row.body),
        sha256(expectedBody),
        `${row.name} stored body must remain byte-identical to 0245`,
      );
    }

    const triggers = await client.query<{
      name: string;
      table_name: string;
      deferrable: boolean;
      initially_deferred: boolean;
      function_name: string;
    }>(`
      SELECT trigger.tgname AS name,
        relation.relname AS table_name,
        trigger.tgdeferrable AS deferrable,
        trigger.tginitdeferred AS initially_deferred,
        function.proname AS function_name
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_proc AS function ON function.oid = trigger.tgfoid
      WHERE trigger.tgname = ANY($1::text[])
      ORDER BY trigger.tgname
    `, [TRIGGER_FACTS.map((fact) => fact.name)]);
    assert.deepEqual(triggers.rows, TRIGGER_FACTS.map((fact) => ({
      name: fact.name,
      table_name: fact.table,
      deferrable: true,
      initially_deferred: true,
      function_name: "check_external_delivery_partition_tail_consistent",
    })).sort((left, right) => left.name.localeCompare(right.name)));

    const purposeConstraint = await client.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'external_app_registration_secret_purpose_valid'
    `);
    assert.equal(purposeConstraint.rows.length, 1);
    assert.match(purposeConstraint.rows[0]!.definition, /'signing_secret'/);
    assert.match(purposeConstraint.rows[0]!.definition, /'manifest_manager'/);
    assert.match(
      purposeConstraint.rows[0]!.definition,
      /'oauth_client_secret'/,
      "the durable OAuth app-secret authority must not be stored as manifest_manager",
    );

    const identityConstraints = await client.query<{
      name: string;
      definition: string;
    }>(`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'external_human_identity_links'::regclass
      ORDER BY conname
    `);
    const revocation = identityConstraints.rows.find((row) =>
      row.name === "external_human_identity_revocation_valid"
    );
    assert.ok(revocation);
    assert.match(revocation.definition, /state.*active/);
    assert.match(revocation.definition, /state.*revoked/);

    const identityIndexes = await client.query<{
      name: string;
      definition: string;
    }>(`
      SELECT indexname AS name, indexdef AS definition
      FROM pg_indexes
      WHERE tablename = 'external_human_identity_links'
      ORDER BY indexname
    `);
    for (const indexName of [
      "idx_external_human_identity_active_provider_user",
      "idx_external_human_identity_active_user",
    ]) {
      const index = identityIndexes.rows.find((row) => row.name === indexName);
      assert.ok(index, `missing ${indexName}`);
      assert.match(index.definition, /UNIQUE/);
      assert.match(index.definition, /WHERE \(state = 'active'/);
    }
  } finally {
    await client.close();
  }
});
