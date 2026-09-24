import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import pg from "pg";
import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  reconcileAndVerifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivilegeReceipt,
} from "./featureFlagAdminPrivileges.js";

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
  await target.query("CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL)");
  await target.query("CREATE TABLE servers (id uuid PRIMARY KEY, slug text NOT NULL, deleted_at timestamptz, name text NOT NULL)");
  await target.query("CREATE TABLE feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true)");
  await target.query("CREATE TABLE feature_flag_rules (id uuid PRIMARY KEY, flag_key text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE, stage text NOT NULL)");
  await target.query("CREATE TABLE feature_flag_audiences (key text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT false)");
  await target.query("CREATE TABLE feature_flag_audience_members (id uuid PRIMARY KEY, audience_key text NOT NULL REFERENCES feature_flag_audiences(key), kind text NOT NULL, target_id uuid NOT NULL)");

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

  // 0240 may be journaled where the production-only role is absent, but it
  // installs a reconciler instead of silently becoming a no-op. Required mode
  // cannot pass until that source-owned reconciler runs and writes its receipt.
  await target.query(migration);
  await target.query(audienceMigration.slice(reconcilerStart));
  await target.query(deletePrivilegeMigration);
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

  // A hand-built copy of the complete grants is deliberately insufficient:
  // state readback can pass, but the migration receipt remains absent.
  await target.query(`GRANT USAGE ON SCHEMA public TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE ON TABLE public.announcements TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT ON TABLE public.announcement_audit_events TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feature_flags, public.feature_flag_rules TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, UPDATE ON TABLE public.feature_flag_audiences TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT, INSERT, DELETE ON TABLE public.feature_flag_audience_members TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (id) ON TABLE public.users TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
  await target.query(`GRANT SELECT (id, slug, deleted_at) ON TABLE public.servers TO ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
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
  await operator.query("SELECT id, slug, deleted_at FROM servers");
  await assert.rejects(
    operator.query("DELETE FROM announcements"),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    operator.query("UPDATE announcement_audit_events SET announcement_id = announcement_id"),
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
