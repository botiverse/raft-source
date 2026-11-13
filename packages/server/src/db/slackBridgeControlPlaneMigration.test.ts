import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { migratePglite } from "./pgliteMigrations";

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0252_slack_bridge_launch_gate.sql", import.meta.url),
);
const AUTHOR_POLICY_REMOVAL = fileURLToPath(
  new URL("../../drizzle/0278_remove_external_author_policy_model.sql", import.meta.url),
);
const DRIZZLE_ROOT = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const SERVER_SRC = fileURLToPath(new URL("../", import.meta.url));

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  }));
  return nested.flat();
}

async function migrationDirectoryThrough(maxIndex: number): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "slack-policy-removal-"));
  await mkdir(path.join(directory, "meta"));
  const journal = JSON.parse(await readFile(path.join(DRIZZLE_ROOT, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  await writeFile(path.join(directory, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await symlink(
      path.join(DRIZZLE_ROOT, `${entry.tag}.sql`),
      path.join(directory, `${entry.tag}.sql`),
    );
  }
  return { path: directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

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

    const preservedKey = SLACK_BRIDGE_FEATURE_FLAG_KEYS.master;
    await client.query(`
      UPDATE feature_flags
      SET enabled = false, kill_switch = true, default_enabled = true,
        default_variant = 'operator-owned', salt = 'operator-owned-salt'
      WHERE key = $1
    `, [preservedKey]);
    await client.query(`
      INSERT INTO feature_flag_config_versions (scope, version, updated_by)
      VALUES ('global', 42, 'operator')
      ON CONFLICT (scope) DO UPDATE SET version = EXCLUDED.version, updated_by = EXCLUDED.updated_by
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

test("0278 removes the per-author policy data model without compatibility residue", async () => {
  const sql = (await readFile(AUTHOR_POLICY_REMOVAL, "utf8")).trim();
  assert.match(sql, /DROP TABLE "external_author_policies" CASCADE;/u);
  assert.match(sql, /DELETE FROM "external_projection_avatar_artifacts" WHERE "owner_type" IN \('user', 'agent'\);/u);
  assert.match(sql, /DELETE FROM "external_outbound_deliveries";/u);
  assert.match(sql, /DELETE FROM "external_delivery_partitions";/u);
  assert.match(sql, /SET DEFAULT 'slack-bridge-render-snapshot\.v3'/u);
  assert.match(sql, /"owner_type" = 'external_projection'/u);
  const client = new PGlite();
  const before = await migrationDirectoryThrough(277);
  try {
    await migratePglite(client, before.path);
    await client.exec(`
      INSERT INTO feature_flag_rules (id, flag_key, stage, decision, values)
      VALUES
        ('01000000-0000-4000-8000-000000000001', 'slack_provider_dispatch', 'server', 'allow', '["legacy-server"]'::jsonb),
        ('01000000-0000-4000-8000-000000000002', 'slack_bridge_v0', 'server', 'allow', '["product-server"]'::jsonb);
    `);
    const productFlagsBefore = await client.query(`
      SELECT key, enabled, kill_switch, randomization_unit, default_enabled,
        default_variant, salt, created_at, updated_at
      FROM feature_flags
      WHERE key IN ('slack_bridge_v0', 'slack_attachment_transfer', 'slack_reaction_sync')
      ORDER BY key
    `);
    const productRulesBefore = await client.query(`
      SELECT id, flag_key, stage, priority, decision, values,
        percentage_basis_points, variant, created_at, updated_at
      FROM feature_flag_rules
      WHERE flag_key IN ('slack_bridge_v0', 'slack_attachment_transfer', 'slack_reaction_sync')
      ORDER BY id
    `);
    await client.exec(`
      INSERT INTO users (id, email, name, password_hash)
      VALUES ('10000000-0000-4000-8000-000000000001', 'legacy@example.test', 'legacy', 'test');
      INSERT INTO servers (id, name, slug, owner_id)
      VALUES ('20000000-0000-4000-8000-000000000001', 'Legacy', 'legacy', '10000000-0000-4000-8000-000000000001');
      INSERT INTO channels (id, server_id, name, type)
      VALUES ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'legacy', 'channel');
      INSERT INTO messages (id, channel_id, sender_type, sender_id, content)
      VALUES
        ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'user', '10000000-0000-4000-8000-000000000001', 'queued source'),
        ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'user', '10000000-0000-4000-8000-000000000001', 'accepted source');
      INSERT INTO external_author_policies (
        id, server_id, provider, app_registration_id, install_id, binding_id,
        binding_epoch, author_type, author_id, display_name, fallback_kind,
        consent_revision, state
      ) VALUES (
        '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
        'slack', 'legacy-registration', 'legacy-install', 'legacy-binding', 1,
        'user', '10000000-0000-4000-8000-000000000001', 'Legacy', 'human', 1, 'granted'
      );
      INSERT INTO external_projection_avatar_artifacts (
        id, owner_type, owner_id, source_digest, public_url, mime_type,
        byte_size, width, height, artifact_revision, state
      ) VALUES (
        '60000000-0000-4000-8000-000000000001', 'user',
        '10000000-0000-4000-8000-000000000001', '${"a".repeat(64)}',
        'https://cdn.raft.test/legacy.webp', 'image/webp', 1, 1, 1, 1, 'active'
      );
      INSERT INTO external_delivery_partitions (
        id, binding_id, binding_epoch, last_enqueued_position, cursor_position
      ) VALUES
        ('70000000-0000-4000-8000-000000000001', 'legacy-queued', 1, 1, 0),
        ('70000000-0000-4000-8000-000000000002', 'legacy-accepted', 1, 1, 1);
      INSERT INTO external_outbound_deliveries (
        id, source_message_id, binding_id, binding_epoch, partition_position,
        enqueue_runtime_revision, state, render_snapshot_schema, render_snapshot,
        render_snapshot_digest, reconciliation_marker,
        provider_attempts, first_dispatched_at, provider_message_id, accepted_at
      ) VALUES
        ('80000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
          'legacy-queued', 1, 1, 'legacy-runtime', 'queued', 'slack-bridge-render-snapshot.v2',
          '{}'::jsonb, '${"b".repeat(64)}', '${"Q".repeat(43)}', 0, NULL, NULL, NULL),
        ('80000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
          'legacy-accepted', 1, 1, 'legacy-runtime', 'accepted', 'slack-bridge-render-snapshot.v2',
          '{}'::jsonb, '${"c".repeat(64)}', '${"A".repeat(43)}', 1, now(), '1710000000.000100', now());
      INSERT INTO external_delivery_operator_decisions (
        id, delivery_id, binding_id, binding_epoch, partition_position, action,
        actor_type, actor_id, reason, data_loss_acknowledged, decision_revision
      ) VALUES (
        '90000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
        'legacy-queued', 1, 1, 'skip', 'user', '10000000-0000-4000-8000-000000000001',
        'legacy cleanup', true, 1
      );
      INSERT INTO external_delivery_attempts (
        id, delivery_id, attempt_number, lease_generation, runtime_revision,
        credential_revision, dispatch_authorization, provider_io_started_at,
        outcome, outcome_reason, terminal_at
      ) VALUES (
        '91000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002',
        1, 1, 'legacy-runtime', 1, 'automatic', now(), 'accepted', 'provider_accepted', now()
      );
      INSERT INTO external_message_links (
        id, delivery_id, provider, install_id, provider_authority_id,
        provider_conversation_id, provider_message_id, binding_id, binding_epoch,
        connection_epoch, raft_message_id, first_direction, payload_fingerprint,
        outcome_state, authority_state
      ) VALUES (
        '92000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002',
        'slack', 'legacy-install', 'legacy-workspace', 'CLEGACY', '1710000000.000100',
        'legacy-accepted', 1, 1, '40000000-0000-4000-8000-000000000002',
        'raft_outbound', '${"d".repeat(64)}', 'accepted', 'active'
      );
    `);
    await migratePglite(client);
    const table = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.external_author_policies')::text AS relation",
    );
    assert.deepEqual(table.rows, [{ relation: null }]);
    const residue = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_catalog.pg_class
      WHERE relname LIKE '%external_author_policy%'
         OR relname LIKE '%external_author_policies%'
    `);
    assert.deepEqual(residue.rows, [{ count: 0 }]);
    const runtimeRows = await client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM external_outbound_deliveries)
        + (SELECT count(*) FROM external_delivery_partitions)
        + (SELECT count(*) FROM external_delivery_attempts)
        + (SELECT count(*) FROM external_delivery_operator_decisions)
        + (SELECT count(*) FROM external_message_links WHERE delivery_id IS NOT NULL)
      )::int AS count
    `);
    assert.deepEqual(runtimeRows.rows, [{ count: 0 }]);
    const obsoleteFlags = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM feature_flags
      WHERE key IN (
        'external_projection_directory', 'slack_binding_control_plane',
        'slack_outbound_enqueue', 'slack_provider_dispatch', 'slack_custom_authorship',
        'slack_native_mentions', 'slack_thread_delivery', 'slack_private_binding',
        'slack_event_ingress', 'slack_inbound_projection'
      )
    `);
    assert.deepEqual(obsoleteFlags.rows, [{ count: 0 }]);
    const obsoleteRules = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM feature_flag_rules
      WHERE flag_key = 'slack_provider_dispatch'
    `);
    assert.deepEqual(obsoleteRules.rows, [{ count: 0 }], "obsolete rules cascade with their flag");
    assert.deepEqual(await client.query(`
      SELECT key, enabled, kill_switch, randomization_unit, default_enabled,
        default_variant, salt, created_at, updated_at
      FROM feature_flags
      WHERE key IN ('slack_bridge_v0', 'slack_attachment_transfer', 'slack_reaction_sync')
      ORDER BY key
    `), productFlagsBefore, "product flag rows stay byte-equivalent");
    assert.deepEqual(await client.query(`
      SELECT id, flag_key, stage, priority, decision, values,
        percentage_basis_points, variant, created_at, updated_at
      FROM feature_flag_rules
      WHERE flag_key IN ('slack_bridge_v0', 'slack_attachment_transfer', 'slack_reaction_sync')
      ORDER BY id
    `), productRulesBefore, "product flag rules stay byte-equivalent");
    const preserved = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM messages
      WHERE id IN (
        '40000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000002'
      )
    `);
    assert.deepEqual(preserved.rows, [{ count: 2 }], "canonical source messages survive runtime cleanup");
    await assert.rejects(client.query(`
      INSERT INTO external_projection_avatar_artifacts (
        id, owner_type, owner_id, source_digest, public_url, mime_type,
        byte_size, width, height, artifact_revision, state
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        'user', 'legacy-user', $1, 'https://cdn.raft.test/legacy.webp',
        'image/webp', 1, 1, 1, 1, 'active'
      )
    `, ["a".repeat(64)]), /external_avatar_shape_valid/u);
  } finally {
    await before.cleanup();
    await client.close();
  }
});

test("Slack runtime source has no per-author policy compatibility seam", async () => {
  const self = fileURLToPath(import.meta.url);
  const hits: string[] = [];
  for (const file of await typescriptFiles(SERVER_SRC)) {
    if (file === self) continue;
    const source = await readFile(file, "utf8");
    if (/externalAuthorPolicies|ExternalAuthorPolicy|authorPolicy|consentRevision|slack-bridge-render-snapshot\.v[12]/u.test(source)) {
      hits.push(path.relative(SERVER_SRC, file));
    }
  }
  assert.deepEqual(hits, []);
});
