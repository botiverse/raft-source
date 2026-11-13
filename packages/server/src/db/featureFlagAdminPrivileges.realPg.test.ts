import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  reconcileAndVerifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivilegeReceipt,
} from "./featureFlagAdminPrivileges";

const ADMIN_URL = process.env.FEATURE_FLAG_ADMIN_PRIVILEGES_REAL_PG_URL;
const REQUIRED = process.env.FEATURE_FLAG_ADMIN_PRIVILEGES_REAL_PG_REQUIRED === "1";
const WRONG_LOGIN_ROLE = "feature_flag_admin_wrong_login";
const OPERATOR_PASSWORD = "feature-flag-admin-test-only";

test("real PostgreSQL proves durable reconciliation, exact grants, and binding identity", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) throw new Error("FEATURE_FLAG_ADMIN_PRIVILEGES_REAL_PG_URL is required");
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `feature_flag_admin_privileges_${Date.now()}`;
  await admin.query(`DROP ROLE IF EXISTS ${WRONG_LOGIN_ROLE}`);
  await admin.query(`DROP ROLE IF EXISTS ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await admin.query(`CREATE DATABASE ${dbName}`);

  const targetUrl = new URL(ADMIN_URL);
  targetUrl.pathname = `/${dbName}`;
  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  let operator: pg.Client | undefined;
  t.onTestFinished(async () => {
    await operator?.end().catch(() => undefined);
    await target.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${WRONG_LOGIN_ROLE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  await target.query("CREATE TABLE announcements (id uuid PRIMARY KEY, status text NOT NULL)");
  await target.query("CREATE TABLE announcement_audit_events (id uuid PRIMARY KEY, announcement_id uuid NOT NULL)");
  await target.query(`CREATE TABLE announcement_image_assets (
    id uuid PRIMARY KEY,
    storage_key text NOT NULL UNIQUE,
    content_type text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    size_bytes integer NOT NULL,
    created_by_user_id uuid,
    created_by_agent_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    unreferenced_since timestamptz,
    deleting_at timestamptz
  )`);
  await target.query("CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL)");
  await target.query("CREATE TABLE servers (id uuid PRIMARY KEY, slug text NOT NULL, deleted_at timestamptz, name text NOT NULL, plan text NOT NULL DEFAULT 'free', kind text NOT NULL DEFAULT 'normal')");
  await target.query("CREATE TABLE server_members (server_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL DEFAULT 'member')");
  await target.query("CREATE TABLE subscriptions (id uuid PRIMARY KEY, server_id uuid NOT NULL, plan text NOT NULL, status text NOT NULL, stripe_customer_id text NOT NULL)");
  await target.query("CREATE TABLE lab_definitions (key text PRIMARY KEY, state text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1)");
  await target.query("CREATE TABLE server_lab_access (server_id uuid PRIMARY KEY, enabled boolean NOT NULL, version bigint NOT NULL)");
  await target.query("CREATE TABLE server_lab_enrollments (server_id uuid NOT NULL, lab_key text NOT NULL, enabled boolean NOT NULL, version bigint NOT NULL, PRIMARY KEY (server_id, lab_key))");
  await target.query("CREATE TABLE agents (id uuid PRIMARY KEY, server_id uuid NOT NULL, deleted_at timestamptz, name text NOT NULL, system_prompt text)");
  await target.query("CREATE TABLE feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true)");
  await target.query("CREATE TABLE feature_flag_rules (id uuid PRIMARY KEY, flag_key text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE, stage text NOT NULL)");
  await target.query("CREATE TABLE feature_flag_audiences (key text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT false)");
  await target.query("CREATE TABLE feature_flag_audience_members (id uuid PRIMARY KEY, audience_key text NOT NULL REFERENCES feature_flag_audiences(key), kind text NOT NULL, target_id uuid NOT NULL)");
  await target.query("CREATE TABLE oauth_clients (id uuid PRIMARY KEY, client_id text NOT NULL UNIQUE, server_id uuid NOT NULL, name text NOT NULL, app_type text NOT NULL, publish_status text NOT NULL, enabled boolean NOT NULL DEFAULT true, client_secret_hash text NOT NULL, UNIQUE (id, client_id, server_id))");
  await target.query(`CREATE TABLE official_app_registry (
    oauth_client_id uuid PRIMARY KEY,
    client_key text NOT NULL UNIQUE,
    publisher_server_id uuid NOT NULL,
    auto_install boolean NOT NULL DEFAULT false,
    purpose text NOT NULL,
    status text NOT NULL DEFAULT 'pending_review',
    revision integer NOT NULL DEFAULT 1,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (oauth_client_id, client_key, publisher_server_id) REFERENCES oauth_clients(id, client_id, server_id)
  )`);
  await target.query(`CREATE TABLE integration_audit_events (
    id uuid PRIMARY KEY, server_id uuid, client_id uuid, event_type text NOT NULL, event_category text NOT NULL,
    outcome text NOT NULL, source text NOT NULL, actor_type text NOT NULL, actor_id uuid, requester_type text,
    requester_id uuid, subject_type text, subject_id uuid, target_type text NOT NULL, target_id uuid,
    correlation_id text, request_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, diff jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // The real interactive link card tables (0386); they reference only each other.
  const linkCardTables = readFileSync(new URL("../../drizzle/0386_link_card_interactions.sql", import.meta.url), "utf8");
  await target.query(linkCardTables.replaceAll("--> statement-breakpoint", ""));
  const linkCardSendTarget = readFileSync(new URL("../../drizzle/0400_link_card_operation_send_target.sql", import.meta.url), "utf8");
  await target.query(linkCardSendTarget.replaceAll("--> statement-breakpoint", ""));

  const migration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0240_feature_flag_admin_announcement_privileges.sql",
    ),
    "utf8",
  );
  const audienceMigration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0247_charming_barracuda.sql",
    ),
    "utf8",
  );
  const reconcilerStart = audienceMigration.indexOf(
    "CREATE OR REPLACE FUNCTION public.reconcile_feature_flag_admin_privileges()",
  );
  assert.notEqual(reconcilerStart, -1);
  const deletePrivilegeMigration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0260_feature_flag_admin_delete_privileges.sql",
    ),
    "utf8",
  );
  const previewPrivilegeMigration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0267_feature_flag_admin_preview_privileges.sql",
    ),
    "utf8",
  );
  const labPrivilegeMigration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0303_feature_flag_admin_lab_definitions_privileges.sql",
    ),
    "utf8",
  );
  const traceIdentityPrivilegeMigration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0312_feature_flag_admin_trace_identity_privileges.sql",
    ),
    "utf8",
  );
  const announcementImagePrivilegeMigration = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../drizzle/0333_feature_flag_admin_announcement_image_privileges.sql",
    ),
    "utf8",
  );

  // 0240 may be journaled where the production-only role is absent, but it
  // installs a reconciler instead of silently becoming a no-op. Required mode
  // cannot pass until that source-owned reconciler runs and writes its receipt.
  await target.query(migration);
  await target.query(audienceMigration.slice(reconcilerStart));
  await target.query(deletePrivilegeMigration);
  await target.query(previewPrivilegeMigration);
  await target.query(labPrivilegeMigration);
  await target.query(traceIdentityPrivilegeMigration);
  await target.query(announcementImagePrivilegeMigration);
  const targetingMigration = readFileSync(new URL("../../drizzle/0355_announcement_targeting.sql", import.meta.url), "utf8");
  await target.query(targetingMigration.replaceAll("--> statement-breakpoint", ""));
  const officialRegistryMigration = readFileSync(new URL("../../drizzle/0384_ffa_official_app_registry_privileges.sql", import.meta.url), "utf8");
  await target.query(officialRegistryMigration.replaceAll("--> statement-breakpoint", ""));
  const linkCardResolutionMigration = readFileSync(new URL("../../drizzle/0387_ffa_link_card_resolution_privileges.sql", import.meta.url), "utf8");
  await target.query(linkCardResolutionMigration.replaceAll("--> statement-breakpoint", ""));
  const rulesReachMigration = readFileSync(new URL("../../drizzle/0617_announcement_rules_reach.sql", import.meta.url), "utf8");
  await target.query(rulesReachMigration.replaceAll("--> statement-breakpoint", ""));
  await assert.rejects(
    reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    (error: unknown) => (error as { code?: string }).code === "42704",
  );
  await assert.rejects(
    verifyFeatureFlagAdminPrivilegeReceipt((text, values) => target.query(text, values)),
    /privilege_receipt_missing/,
  );

  await admin.query(
    `CREATE ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} LOGIN PASSWORD '${OPERATOR_PASSWORD}'`,
  );
  await admin.query(`CREATE ROLE ${WRONG_LOGIN_ROLE} NOLOGIN`);

  await target.query(`GRANT SELECT (server_id, user_id, role) ON TABLE public.server_members TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);

  // A hand-built copy of the complete grants is deliberately insufficient:
  // state readback can pass, but the migration receipt remains absent.
  await target.query(`GRANT USAGE ON SCHEMA public TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE ON TABLE public.announcements TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT ON TABLE public.announcement_audit_events TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcement_image_assets TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feature_flags, public.feature_flag_rules TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE ON TABLE public.feature_flag_audiences TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, DELETE ON TABLE public.feature_flag_audience_members TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (id) ON TABLE public.users TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (id, slug, deleted_at, plan, kind) ON TABLE public.servers TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (server_id, plan, status) ON TABLE public.subscriptions TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (server_id, lab_key, enabled) ON TABLE public.server_lab_enrollments TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (server_id, enabled) ON TABLE public.server_lab_access TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (key, name, description, state, created_at, updated_at) ON TABLE public.lab_definitions TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT INSERT (key, name, description, state, created_at, updated_at) ON TABLE public.lab_definitions TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT UPDATE (name, description, state, updated_at) ON TABLE public.lab_definitions TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (id, server_id, deleted_at) ON TABLE public.agents TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at) ON TABLE public.official_app_registry TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT INSERT (oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at) ON TABLE public.official_app_registry TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT UPDATE (auto_install, purpose, status, revision, updated_by_user_id, updated_at) ON TABLE public.official_app_registry TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (id, client_id, server_id, name, app_type, publish_status, enabled) ON TABLE public.oauth_clients TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT INSERT (id, server_id, client_id, event_type, event_category, outcome, source, actor_type, actor_id, subject_type, subject_id, target_type, target_id, request_id, metadata, diff, created_at) ON TABLE public.integration_audit_events TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key, message_id, action_id, state, receipt_revision, last_status_at, resolved_by_user_id, resolution_reason, resolved_at, created_at, updated_at) ON TABLE public.link_card_operations TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT UPDATE (state, resolved_by_user_id, resolution_reason, resolved_at, updated_at) ON TABLE public.link_card_operations TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT EXECUTE ON FUNCTION public.announcement_rules_reach(jsonb, text, uuid[], uuid[], timestamptz) TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));
  await assert.rejects(
    verifyFeatureFlagAdminPrivilegeReceipt((text, values) => target.query(text, values)),
    /privilege_receipt_missing/,
  );

  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  const operatorUrl = new URL(targetUrl);
  operatorUrl.username = FEATURE_FLAG_ADMIN_OPERATOR_ROLE;
  operatorUrl.password = OPERATOR_PASSWORD;
  operator = new pg.Client({ connectionString: operatorUrl.toString() });
  await operator.connect();
  await verifyFeatureFlagAdminPrivileges(
    (text, values) => operator!.query(text, values),
    { requireAuthenticatedUser: true },
  );
  await operator.query("SELECT id FROM announcements");
  await operator.query("INSERT INTO announcements (id, status) VALUES ('00000000-0000-0000-0000-000000000001', 'draft')");
  await operator.query("UPDATE announcements SET status = 'published'");
  await operator.query("INSERT INTO announcement_audit_events (id, announcement_id) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001')");
  await operator.query("SELECT id FROM announcement_audit_events");
  await operator.query("INSERT INTO announcement_image_assets (id, storage_key, content_type, width, height, size_bytes) VALUES ('00000000-0000-4000-8000-000000000008', 'announcements/images/00000000-0000-4000-8000-000000000008', 'image/png', 3, 1, 64)");
  await operator.query("SELECT id, storage_key FROM announcement_image_assets");
  await operator.query("UPDATE announcement_image_assets SET unreferenced_since = NOW() WHERE id = '00000000-0000-4000-8000-000000000008'");
  await operator.query("DELETE FROM announcement_image_assets WHERE id = '00000000-0000-4000-8000-000000000008'");
  await operator.query("INSERT INTO feature_flags (key) VALUES ('temporary')");
  await operator.query("INSERT INTO feature_flag_rules (id, flag_key, stage) VALUES ('00000000-0000-4000-8000-000000000005', 'temporary', 'server')");
  await operator.query("UPDATE feature_flag_rules SET stage = 'user' WHERE flag_key = 'temporary'");
  await operator.query("DELETE FROM feature_flag_rules WHERE flag_key = 'temporary'");
  await operator.query("DELETE FROM feature_flags WHERE key = 'temporary'");
  await operator.query("INSERT INTO feature_flag_audiences (key, name) VALUES ('insiders', 'Insiders')");
  await operator.query("UPDATE feature_flag_audiences SET enabled = true WHERE key = 'insiders'");
  await operator.query("SELECT key FROM feature_flag_audiences");
  await operator.query("INSERT INTO feature_flag_audience_members (id, audience_key, kind, target_id) VALUES ('00000000-0000-4000-8000-000000000003', 'insiders', 'user', '00000000-0000-4000-8000-000000000004')");
  await operator.query("SELECT id FROM feature_flag_audience_members");
  await operator.query("DELETE FROM feature_flag_audience_members WHERE audience_key = 'insiders'");
  await operator.query("SELECT id FROM users");
  await operator.query("SELECT server_id, user_id, role FROM server_members");
  await assert.rejects(operator.query("UPDATE server_members SET role = 'member'"),
    (error: unknown) => (error as { code?: string }).code === "42501");
  await operator.query("SELECT id, slug, deleted_at, plan FROM servers");
  await operator.query("SELECT server_id, plan, status FROM subscriptions");
  await operator.query("SELECT server_id, lab_key, enabled FROM server_lab_enrollments");
  await operator.query("SELECT server_id, enabled FROM server_lab_access");
  await operator.query("SELECT key, name, description, state, created_at, updated_at FROM lab_definitions");
  // Labs catalog admin (0303): the exact INSERT/UPDATE shapes the Worker issues.
  await operator.query("INSERT INTO lab_definitions (key, name, description, state, created_at, updated_at) VALUES ('lab_tmp', 'Tmp', '', 'draft', NOW(), NOW())");
  await operator.query("UPDATE lab_definitions SET name = 'Tmp2', description = 'd', state = 'open', updated_at = NOW() WHERE key = 'lab_tmp'");
  // Trace identity lookup (0312): the Worker reads only these agents columns and HMACs the ids itself.
  await operator.query("SELECT id, server_id, deleted_at FROM agents");
  // Official app registry (0384): list apps, register, approve/disable with a revision bump, audit it.
  await target.query("INSERT INTO users (id, email) VALUES ('00000000-0000-4000-8000-0000000000a1', 'operator@raft.test')");
  await target.query("INSERT INTO oauth_clients (id, client_id, server_id, name, app_type, publish_status, client_secret_hash) VALUES ('00000000-0000-4000-8000-0000000000a2', 'vault-1a2b3c', '00000000-0000-4000-8000-0000000000a3', 'Vault', 'third_party_global', 'published', 'hash')");
  await operator.query("SELECT id, client_id, server_id, name, app_type, publish_status, enabled FROM oauth_clients");
  await operator.query("INSERT INTO official_app_registry (oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000a2', 'vault-1a2b3c', '00000000-0000-4000-8000-0000000000a3', false, 'Credentials', 'pending_review', 1, '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', NOW(), NOW())");
  await operator.query("UPDATE official_app_registry SET status = 'approved', purpose = 'Credentials for agents', auto_install = false, revision = revision + 1, updated_by_user_id = '00000000-0000-4000-8000-0000000000a1', updated_at = NOW() WHERE oauth_client_id = '00000000-0000-4000-8000-0000000000a2'");
  await operator.query("SELECT oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at FROM official_app_registry");
  await operator.query("INSERT INTO integration_audit_events (id, server_id, client_id, event_type, event_category, outcome, source, actor_type, actor_id, subject_type, subject_id, target_type, target_id, request_id, metadata, diff, created_at) VALUES ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a2', 'official_app.registry_updated', 'registration', 'success', 'web', 'human', '00000000-0000-4000-8000-0000000000a1', 'app', '00000000-0000-4000-8000-0000000000a2', 'app', '00000000-0000-4000-8000-0000000000a2', 'req-1', '{}'::jsonb, NULL, NOW())");
  for (const forbiddenRegistryQuery of [
    "DELETE FROM official_app_registry",
    "TRUNCATE official_app_registry",
    "UPDATE official_app_registry SET client_key = client_key",
    "UPDATE official_app_registry SET publisher_server_id = publisher_server_id",
    "UPDATE official_app_registry SET oauth_client_id = oauth_client_id",
    "UPDATE official_app_registry SET created_by_user_id = NULL",
    "SELECT client_secret_hash FROM oauth_clients",
    "SELECT * FROM oauth_clients",
    "UPDATE oauth_clients SET name = name",
    "INSERT INTO oauth_clients (id, client_id, server_id, name, app_type, publish_status, client_secret_hash) VALUES ('00000000-0000-4000-8000-0000000000a5', 'x-1a2b3c', '00000000-0000-4000-8000-0000000000a3', 'X', 'server_local', 'private', 'h')",
    "SELECT id FROM integration_audit_events",
    "UPDATE integration_audit_events SET outcome = outcome",
    "DELETE FROM integration_audit_events",
    "INSERT INTO integration_audit_events (id, event_type, event_category, outcome, source, actor_type, target_type, correlation_id) VALUES ('00000000-0000-4000-8000-0000000000a6', 'x', 'registration', 'success', 'web', 'human', 'app', 'c')",
  ]) {
    await assert.rejects(
      operator.query(forbiddenRegistryQuery),
      (error: unknown) => (error as { code?: string }).code === "42501",
      forbiddenRegistryQuery,
    );
  }
  // Announcement reach with rules (0617): the operator gets a count through the function but
  // still cannot read the columns it is computed from.
  await target.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS display_language text");
  await target.query("ALTER TABLE servers ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()");
  const rulesReach = await operator.query(
    "SELECT public.announcement_rules_reach($1::jsonb, 'all', NULL, NULL, now()) AS n",
    [JSON.stringify({ match: "all", groups: [{ match: "all", conditions: [{ field: "account_created", op: "within_days", days: 30 }] }] })],
  );
  assert.ok(rulesReach.rows[0].n === null || typeof rulesReach.rows[0].n === "number");
  for (const forbiddenReachColumn of [
    "SELECT created_at FROM users",
    "SELECT display_language FROM users",
    "SELECT created_at FROM servers",
  ]) {
    await assert.rejects(
      operator.query(forbiddenReachColumn),
      (error: unknown) => (error as { code?: string }).code === "42501",
      forbiddenReachColumn,
    );
  }
  // Stuck link card operations (0387): list them and resolve one manually; nothing else.
  const linkCardOp = (id: string, state: string) => target.query(
    "INSERT INTO link_card_operations (operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key, registration_revision, view_nonce, message_id, url_sha256, action_endpoint_sha256, action_origin, created_at, first_send_deadline, action_id, request_sha256, state) VALUES ($1, '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a3', 'app', 'vault-1a2b3c', '00000000-0000-4000-8000-0000000000b2', 'rev-1', 'nonce-1', '00000000-0000-4000-8000-0000000000b3', encode(sha256('https://vault.example/r/1'), 'hex'), repeat('a', 64), 'https://vault.example', date_trunc('second', now()), date_trunc('second', now()) + interval '10 minutes', 'approve', 'r', $2)",
    [id, state],
  );
  const op = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
  await linkCardOp(op("b4"), "needs_reconciliation");
  await linkCardOp(op("b5"), "done");
  await linkCardOp(op("b6"), "unknown");
  await linkCardOp(op("b7"), "needs_reconciliation");
  const resolve = (id: string, state = "resolved_manually") => operator!.query(
    "UPDATE link_card_operations SET state = $2, resolved_by_user_id = '00000000-0000-4000-8000-0000000000a1', resolution_reason = 'Checked in Vault: approved by the owner', resolved_at = NOW(), updated_at = NOW() WHERE operation_id = $1",
    [id, state],
  );
  await operator.query("SELECT operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key, message_id, action_id, state, receipt_revision, last_status_at, resolved_by_user_id, resolution_reason, resolved_at, created_at, updated_at FROM link_card_operations");
  await operator.query("SELECT operation_id FROM link_card_operations WHERE state = 'needs_reconciliation' FOR UPDATE");
  // The one allowed path, and the trigger bumps receipt_revision by exactly 1.
  await resolve(op("b4"));
  const [resolvedRow] = (await target.query("SELECT state, receipt_revision FROM link_card_operations WHERE operation_id = $1", [op("b4")])).rows;
  assert.deepEqual(resolvedRow, { state: "resolved_manually", receipt_revision: 1 });
  for (const forbiddenLinkCardQuery of [
    "SELECT view_nonce FROM link_card_operations",
    "SELECT request_sha256 FROM link_card_operations",
    "SELECT registration_revision FROM link_card_operations",
    "SELECT url_sha256 FROM link_card_operations",
    "SELECT action_endpoint_sha256, action_origin FROM link_card_operations",
    "SELECT first_send_deadline FROM link_card_operations",
    "UPDATE link_card_operations SET first_send_deadline = first_send_deadline",
    "SELECT * FROM link_card_operations",
    "INSERT INTO link_card_operations (operation_id) VALUES ('00000000-0000-4000-8000-0000000000c1')",
    "DELETE FROM link_card_operations",
    "TRUNCATE link_card_operations",
    "UPDATE link_card_operations SET installation_key = installation_key",
    "UPDATE link_card_operations SET viewer_id = viewer_id",
    "UPDATE link_card_operations SET receipt_revision = receipt_revision + 1",
    "SELECT operation_id FROM link_card_client_requests",
    "SELECT jti FROM link_card_attempts",
  ]) {
    await assert.rejects(
      operator.query(forbiddenLinkCardQuery),
      (error: unknown) => (error as { code?: string }).code === "42501",
      forbiddenLinkCardQuery,
    );
  }
  const refusedByTrigger = (error: unknown) => (error as { code?: string }).code === "23514";
  // The FFA role can never record an App outcome, resolve anything not in reconciliation,
  // or touch a row outside its one transition (Tenny d4dcfdbd).
  await assert.rejects(resolve(op("b7"), "done").then(() => undefined), refusedByTrigger, "needs_reconciliation -> done");
  await assert.rejects(operator.query("UPDATE link_card_operations SET state = 'done', updated_at = NOW() WHERE operation_id = $1", [op("b7")]), refusedByTrigger);
  await assert.rejects(resolve(op("b6")), refusedByTrigger, "unknown -> resolved_manually");
  await assert.rejects(operator.query("UPDATE link_card_operations SET resolution_reason = 'Rewritten later' WHERE operation_id = $1", [op("b4")]), refusedByTrigger, "rewrite an earlier resolution");
  await assert.rejects(operator.query("UPDATE link_card_operations SET updated_at = NOW() WHERE operation_id = $1", [op("b6")]), refusedByTrigger, "touch an unrelated row");
  // Every other writer follows the state machine and cannot resolve manually.
  await assert.rejects(target.query("UPDATE link_card_operations SET state = 'resolved_manually', resolved_by_user_id = '00000000-0000-4000-8000-0000000000a1', resolution_reason = 'Not an admin path', resolved_at = NOW() WHERE operation_id = $1", [op("b7")]), refusedByTrigger);
  for (const [id, state] of [["b4", "done"], ["b5", "unknown"], ["b5", "sent"]] as const) {
    await assert.rejects(target.query("UPDATE link_card_operations SET state = $2, resolved_by_user_id = NULL, resolution_reason = NULL, resolved_at = NULL WHERE operation_id = $1", [op(id), state]), refusedByTrigger, `${id} -> ${state}`);
  }
  await target.query("UPDATE link_card_operations SET state = 'done' WHERE operation_id = $1", [op("b7")]);
  await assert.rejects(
    operator.query("DELETE FROM announcements"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("UPDATE announcement_audit_events SET announcement_id = announcement_id"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("TRUNCATE announcement_image_assets"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("DELETE FROM feature_flag_audiences"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("UPDATE feature_flag_audience_members SET kind = kind"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("SELECT email FROM users"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("SELECT name FROM servers"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("SELECT stripe_customer_id FROM subscriptions"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("SELECT version FROM server_lab_enrollments"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("SELECT version FROM server_lab_access"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("SELECT version FROM lab_definitions"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("UPDATE lab_definitions SET key = key"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("DELETE FROM lab_definitions"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  for (const forbiddenAgentsQuery of [
    "SELECT name FROM agents",
    "SELECT system_prompt FROM agents",
    "SELECT * FROM agents",
    "INSERT INTO agents (id, server_id, name) VALUES ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000007', 'a')",
    "UPDATE agents SET deleted_at = NOW()",
    "DELETE FROM agents",
  ]) {
    await assert.rejects(
      operator.query(forbiddenAgentsQuery),
      (error: unknown) => (error as { code?: string }).code === "42501",
      forbiddenAgentsQuery,
    );
  }

  // SET ROLE changes current_user but not the authenticated session_user. A
  // broad Hyperdrive login with a startup role must not satisfy readiness.
  await target.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  try {
    await assert.rejects(
      verifyFeatureFlagAdminPrivileges(
        (text, values) => target.query(text, values),
        { requireAuthenticatedUser: true },
      ),
      /session_user_mismatch/,
    );
  } finally {
    await target.query("RESET ROLE");
  }

  // Superusers can rewrite session_user too. The backend principal read from
  // pg_stat_activity remains the identity presented during authentication and
  // exposes the broad login even if system_user is unavailable at a proxy.
  await target.query(`SET SESSION AUTHORIZATION ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  try {
    await assert.rejects(
      verifyFeatureFlagAdminPrivileges(
        (text, values) => target.query(text, values),
        { requireAuthenticatedUser: true },
      ),
      /authenticated_principal_mismatch/,
    );
  } finally {
    await target.query("RESET SESSION AUTHORIZATION");
  }

  // Actual-binding counterexample: the named role is healthy, but a different
  // Hyperdrive login must still make the Worker-facing readiness check red.
  await target.query(`SET ROLE ${WRONG_LOGIN_ROLE}`);
  try {
    await assert.rejects(
      verifyFeatureFlagAdminPrivileges(
        (text, values) => target.query(text, values),
        { requireAuthenticatedUser: true },
      ),
      /session_user_mismatch/,
    );
  } finally {
    await target.query("RESET ROLE");
  }

  // Independent right-cause mutations: schema creation, delegation, and one
  // required route grant each turn the readback red; reconciliation restores.
  await target.query(`GRANT CREATE ON SCHEMA public TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public:CREATE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`GRANT SELECT ON TABLE public.announcements TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} WITH GRANT OPTION`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public\.announcements:SELECT WITH GRANT OPTION/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`REVOKE UPDATE ON TABLE public.announcements FROM ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /missing:public\.announcements:UPDATE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`REVOKE DELETE ON TABLE public.announcement_image_assets FROM ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /missing:public\.announcement_image_assets:DELETE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`REVOKE DELETE ON TABLE public.feature_flag_rules FROM ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /missing:public\.feature_flag_rules:DELETE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`GRANT DELETE ON TABLE public.feature_flag_audiences TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public\.feature_flag_audiences:DELETE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`GRANT SELECT (email) ON TABLE public.users TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public\.users:email:SELECT/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`GRANT UPDATE (email) ON TABLE public.users TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public\.users:email:UPDATE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`GRANT SELECT (name) ON TABLE public.agents TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public\.agents:name:SELECT/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`GRANT SELECT (name) ON TABLE public.feature_flag_audiences TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} WITH GRANT OPTION`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /unexpected:public\.feature_flag_audiences:name:SELECT WITH GRANT OPTION/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));

  await target.query(`REVOKE UPDATE ON TABLE public.feature_flag_audiences FROM ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values)),
    /missing:public\.feature_flag_audiences:UPDATE/,
  );
  await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => target.query(text, values));
});
