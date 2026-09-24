import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { migratePglite } from "./pgliteMigrations.js";

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0252_slack_bridge_launch_gate.sql", import.meta.url),
);

const FLAG_KEYS = Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS)
  .filter((key) => (
    key !== SLACK_BRIDGE_FEATURE_FLAG_KEYS.master
    && key !== SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer
  ))
  .sort();

test("0246 seeds every Slack Bridge flag fail-closed and never overwrites operator state", async () => {
  const client = new PGlite();
  try {
    await migratePglite(client);
    const freshFlags = await client.query<{
      key: string;
      enabled: boolean;
      kill_switch: boolean;
      randomization_unit: string;
      default_enabled: boolean;
      default_variant: string | null;
      salt: string;
    }>(`
      SELECT key, enabled, kill_switch, randomization_unit,
        default_enabled, default_variant, salt
      FROM feature_flags
      WHERE key = ANY($1::text[])
      ORDER BY key
    `, [FLAG_KEYS]);
    assert.deepEqual(freshFlags.rows, FLAG_KEYS.map((key) => ({
      key,
      enabled: true,
      kill_switch: false,
      randomization_unit: "server",
      default_enabled: false,
      default_variant: null,
      salt: key,
    })));
    const master = await client.query<{
      enabled: boolean;
      kill_switch: boolean;
      randomization_unit: string;
      default_enabled: boolean;
      default_variant: string | null;
      salt: string;
    }>(`
      SELECT enabled, kill_switch, randomization_unit,
        default_enabled, default_variant, salt
      FROM feature_flags
      WHERE key = $1
    `, [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master]);
    assert.deepEqual(master.rows, [{
      enabled: true,
      kill_switch: false,
      randomization_unit: "server",
      default_enabled: false,
      default_variant: null,
      salt: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    }]);
    const masterRules = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM feature_flag_rules
      WHERE flag_key = $1
    `, [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master]);
    assert.deepEqual(masterRules.rows, [{ count: 0 }], "launch remains off until an audited server rule exists");
    const attachmentFlag = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM feature_flags WHERE key = $1
    `, [SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer]);
    assert.deepEqual(attachmentFlag.rows, [{ count: 0 }],
      "new attachment rollout authority is created only through the audited flag control plane");

    const freshVersion = await client.query<{ scope: string; version: number }>(`
      SELECT scope, version::int AS version
      FROM feature_flag_config_versions
      WHERE scope = 'global'
    `);
    assert.deepEqual(freshVersion.rows, []);

    const preservedKey = SLACK_BRIDGE_FEATURE_FLAG_KEYS.dispatch;
    await client.query(`
      UPDATE feature_flags
      SET enabled = false, kill_switch = true, default_enabled = true,
        default_variant = 'operator-owned', salt = 'operator-owned-salt'
      WHERE key = $1
    `, [preservedKey]);
    await client.query(`
      INSERT INTO feature_flag_config_versions (scope, version, updated_by)
      VALUES ('global', 42, 'operator')
    `);

    const sql = await readFile(MIGRATION, "utf8");
    const seedStatements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) =>
        statement.startsWith('INSERT INTO "feature_flags"')
      );
    assert.equal(seedStatements.length, 1, "the idempotent flag seed remains present");
    for (const statement of seedStatements) await client.exec(statement);
    await migratePglite(client);

    const preservedFlag = await client.query<{
      enabled: boolean;
      kill_switch: boolean;
      default_enabled: boolean;
      default_variant: string;
      salt: string;
    }>(`
      SELECT enabled, kill_switch, default_enabled, default_variant, salt
      FROM feature_flags
      WHERE key = $1
    `, [preservedKey]);
    assert.deepEqual(preservedFlag.rows, [{
      enabled: false,
      kill_switch: true,
      default_enabled: true,
      default_variant: "operator-owned",
      salt: "operator-owned-salt",
    }]);
    const preservedVersion = await client.query<{
      version: number;
      updated_by: string;
    }>(`
      SELECT version::int AS version, updated_by
      FROM feature_flag_config_versions
      WHERE scope = 'global'
    `);
    assert.deepEqual(preservedVersion.rows, [{ version: 42, updated_by: "operator" }]);
  } finally {
    await client.close();
  }
});
