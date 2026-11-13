import { LEGACY_OAUTH_SCOPE_ALLOWLIST } from "../services/oauthClientKeys";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import {
  APP_ADMIN_EXECUTABLE_FUNCTIONS,
  APP_ADMIN_OPERATOR_ROLE,
  APP_ADMIN_PRIVILEGE_CONTRACT_KEY,
  APP_ADMIN_PRIVILEGE_MIGRATION_TAG,
  APP_ADMIN_READABLE_COLUMNS,
  AppAdminPrivilegeError,
  MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION,
  reconcileAndVerifyAppAdminPrivileges,
  verifyAppAdminPrivilegeReceipt,
  verifyAppAdminPrivileges,
} from "./appAdminPrivileges";
import { migratePglite } from "./pgliteMigrations";

// App Admin's role may run the gated review entries, the official registry
// functions and the template entries, read the columns its pages show, and
// nothing else. Each case migrates its own PGlite (the
// production initializer), because roles and SET ROLE outlive a case on a
// shared database.

const [DECIDE, DECIDE_CARD_URL, APPROVE_PERMISSION, REGISTER, UPDATE, CREATE_TEMPLATE, UPDATE_TEMPLATE, RETIRE_TEMPLATE, CHANGE_CLIENT_KEY] = APP_ADMIN_EXECUTABLE_FUNCTIONS;
// The decision bodies and the gate behind the entries: the owner's only.
const PUBLISH_BODY = "public.marketplace_decide_publish_review(uuid, text, text, text, uuid, text)";
const CARD_URL_BODY = "public.marketplace_decide_action_endpoint_review(uuid, text, text, uuid, text)";
const PERMISSION_BODY = "public.marketplace_approve_permission_review(uuid, uuid, uuid)";
const GATE = "public.marketplace_review_require_decider(text, uuid)";
// The rename behind App Admin's entry, and the list it checks: the owner's only.
const RENAME_BODY = "public.oauth_client_change_key(uuid, text, boolean, text, uuid, text, text)";
const LEGACY_KEYS = "public.oauth_client_legacy_scope_keys()";
// The template entries' helper: never App Admin's to call.
const TEMPLATE_ENTRY = "public.mcp_app_template_admin_entry(public.mcp_app_templates)";
// App Admin's guard looks the marker up; it never executes it.
const MARKER = MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION;
const BOTIVERSE_SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";

async function migrated(): Promise<PGlite> {
  const pg = new PGlite();
  await migratePglite(pg);
  return pg;
}

const query = (pg: PGlite) => async (text: string, values?: unknown[]) => pg.query<Record<string, unknown>>(text, values);

/** An App in the given publish status (by default waiting for publish review), and a person to review it. */
async function publishRequest(pg: PGlite, publishStatus = "publish_requested") {
  const userId = randomUUID();
  const serverId = randomUUID();
  const clientId = randomUUID();
  await pg.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'fixture-value-not-a-credential')", [userId, `${userId}@example.test`, `reviewer-${userId.slice(0, 8)}`]);
  await pg.query("INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 'Source', $2, $3)", [serverId, `s-${serverId.slice(0, 8)}`, userId]);
  await pg.query(
    `INSERT INTO oauth_clients (id, server_id, client_id, client_secret_hash, name, description, created_by_user_id, app_type, publish_status)
     VALUES ($1, $2, $3, 'fixture-value-not-a-credential', 'Fixture', 'A listed App.', $4, 'third_party_global', $5)`,
    [clientId, serverId, `c-${clientId.slice(0, 8)}`, userId, publishStatus],
  );
  return { userId, clientId };
}

/** Makes the person an admin of Botiverse, which review decisions require. */
async function botiverseAdmin(pg: PGlite, userId: string) {
  await pg.query("INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 'Botiverse', 'botiverse-fixture', $2) ON CONFLICT (id) DO NOTHING", [BOTIVERSE_SERVER_ID, userId]);
  await pg.query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')", [BOTIVERSE_SERVER_ID, userId]);
}

/** An action endpoint waiting for review on the App's link-preview registration. */
async function cardUrlRequest(pg: PGlite, clientId: string) {
  const origin = `https://${clientId.slice(0, 8)}.example.test`;
  await pg.query(
    `INSERT INTO oauth_app_link_previews (client_id, origin, endpoint, paths, revision, pending_action_endpoint, pending_action_endpoint_requested_at)
     VALUES ($1, $2, $3, '["/x/*"]', gen_random_uuid(), $4, now())`,
    [clientId, origin, `${origin}/preview`, `${origin}/actions`],
  );
  return `${origin}/actions`;
}

/** A permission revision waiting for review on the App (it asks for the server group). */
async function permissionRequest(pg: PGlite, clientId: string, userId: string) {
  const revisionId = randomUUID();
  await pg.query(
    `INSERT INTO oauth_app_permission_revisions (id, client_id, revision, requested_groups, requested_events, state, created_by_type, created_by_id)
     VALUES ($1, $2, 1, '["server"]', '[]', 'pending_review', 'human', $3)`,
    [revisionId, clientId, userId],
  );
  await pg.query("UPDATE oauth_clients SET outbound_request_revision = 1, outbound_pending_revision_id = $1 WHERE id = $2", [revisionId, clientId]);
  return revisionId;
}

async function keyOfApp(pg: PGlite, id: string): Promise<string> {
  return (await pg.query<{ client_id: string }>("SELECT client_id FROM oauth_clients WHERE id = $1", [id])).rows[0].client_id;
}

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  assert.fail("expected the statement to be refused");
}

async function verifyRefusal(pg: PGlite): Promise<string> {
  try {
    await verifyAppAdminPrivileges(query(pg));
  } catch (error) {
    assert.ok(error instanceof AppAdminPrivilegeError, String(error));
    return error.reason;
  }
  return "verified";
}

test("the receipt names this contract's migration as the journal does (a renumber must carry the tag)", () => {
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === APP_ADMIN_PRIVILEGE_MIGRATION_TAG), APP_ADMIN_PRIVILEGE_MIGRATION_TAG);
  const sql = readFileSync(new URL(`../../drizzle/${APP_ADMIN_PRIVILEGE_MIGRATION_TAG}.sql`, import.meta.url), "utf8");
  assert.ok(sql.includes(`'${APP_ADMIN_PRIVILEGE_MIGRATION_TAG}'`), "the reconciler writes the same tag into its receipt");
});

test("a database without the reconciler fails a deploy and is skipped elsewhere", async () => {
  // A migration test runs db:migrate:deploy against its own throwaway journal,
  // so the reconciler was never created; a real deploy has just created it.
  const pg = new PGlite();
  try {
    await assert.rejects(
      reconcileAndVerifyAppAdminPrivileges(query(pg)),
      (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "reconciler_missing",
    );
    await assert.rejects(
      reconcileAndVerifyAppAdminPrivileges(query(pg), { requireReconciler: true }),
      (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "reconciler_missing",
    );
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg), { requireReconciler: false }), "reconciler_missing");
  } finally {
    await pg.close();
  }
});

test("with the reconciler present, not requiring it changes nothing", async () => {
  const pg = await migrated();
  try {
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg), { requireReconciler: false }), "role_missing");
  } finally {
    await pg.close();
  }
});

test("until app_admin_operator exists the reconciler grants nothing and writes no receipt", async () => {
  const pg = await migrated();
  try {
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "role_missing");
    assert.equal((await pg.query("SELECT 1 FROM public.app_admin_privilege_receipts")).rows.length, 0);
    assert.equal(await verifyRefusal(pg), "role_missing");
    // Nobody but the owner may run the functions, the bodies and gate behind the entries, or the reconciler.
    for (const fn of [...APP_ADMIN_EXECUTABLE_FUNCTIONS, PUBLISH_BODY, CARD_URL_BODY, PERMISSION_BODY, GATE, RENAME_BODY, LEGACY_KEYS, MARKER, TEMPLATE_ENTRY, "public.reconcile_app_admin_privileges()"]) {
      const { rows } = await pg.query<{ allowed: boolean }>("SELECT pg_catalog.has_function_privilege('public', $1, 'EXECUTE') AS allowed", [fn]);
      assert.equal(rows[0]?.allowed, false, fn);
    }
  } finally {
    await pg.close();
  }
});

test("app_admin_operator decides reviews through the gated entries but cannot call the bodies or write the tables, and its temporary tables cannot redirect the functions", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const { rows: [receipt] } = await pg.query<{ migration_tag: string; applied_by: string }>(
      "SELECT migration_tag, applied_by FROM public.app_admin_privilege_receipts WHERE contract_key = $1",
      [APP_ADMIN_PRIVILEGE_CONTRACT_KEY],
    );
    assert.equal(APP_ADMIN_PRIVILEGE_CONTRACT_KEY, "app-admin-functions-v9");
    assert.deepEqual(receipt, { migration_tag: APP_ADMIN_PRIVILEGE_MIGRATION_TAG, applied_by: "postgres" });

    const first = await publishRequest(pg);
    const second = await publishRequest(pg);
    const card = await publishRequest(pg, "published");
    const pendingActionEndpoint = await cardUrlRequest(pg, card.clientId);
    const permission = await publishRequest(pg, "published");
    const pendingRevisionId = await permissionRequest(pg, permission.clientId, permission.userId);
    for (const review of [first, second, card, permission]) await botiverseAdmin(pg, review.userId);
    // Installed on their source Servers before the decision, so each decision has a Server to tell.
    for (const review of [first, permission]) {
      await pg.query(
        `INSERT INTO oauth_client_installs (id, server_id, client_id, installed_by_user_id)
         SELECT gen_random_uuid(), server_id, id, created_by_user_id FROM oauth_clients WHERE id = $1`,
        [review.clientId],
      );
    }
    const decide = (review: { userId: string; clientId: string }) => pg.query<{ result: { status: string } }>(
      "SELECT public.app_admin_decide_publish_review($1, 'approve', 'publish_requested', 'human', $2, NULL) AS result",
      [review.clientId, review.userId],
    );

    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    try {
      // Same-named temporary tables, created before the session's first call
      // (plpgsql caches a function's plans per session): the functions still
      // reach only public.* (search_path pg_catalog, pg_temp; every relation
      // schema-qualified).
      for (const table of ["oauth_clients", "oauth_client_installs", "oauth_app_text_revisions", "oauth_app_link_previews", "oauth_app_permission_revisions", "oauth_app_installation_tokens", "integration_audit_events", "users", "agents", "external_app_registrations", "server_members", "servers", "marketplace_review_outbox"]) {
        await pg.query(`CREATE TEMP TABLE ${table} (id uuid)`);
      }
      // The bodies and the gate are reached only through the entries.
      assert.equal(await sqlState(pg.query(
        "SELECT public.marketplace_decide_publish_review($1, 'approve', 'publish_requested', 'human', $2, NULL)", [first.clientId, first.userId],
      )), "42501");
      assert.equal(await sqlState(pg.query(
        "SELECT public.marketplace_decide_action_endpoint_review($1, 'approve', $2, $3, NULL)", [card.clientId, pendingActionEndpoint, card.userId],
      )), "42501");
      assert.equal(await sqlState(pg.query(
        "SELECT public.marketplace_approve_permission_review($1, $2, $3)", [permission.clientId, pendingRevisionId, permission.userId],
      )), "42501");
      assert.equal(await sqlState(pg.query("SELECT public.marketplace_review_require_decider('human', $1)", [first.userId])), "42501");

      assert.equal((await decide(first)).rows[0]?.result.status, "published");
      const { rows: [approved] } = await pg.query<{ result: { decision: string; actionEndpoint: string } }>(
        "SELECT public.app_admin_decide_action_endpoint_review($1, 'approve', $2, 'human', $3, NULL) AS result",
        [card.clientId, pendingActionEndpoint, card.userId],
      );
      assert.deepEqual([approved?.result.decision, approved?.result.actionEndpoint], ["approve", pendingActionEndpoint]);
      const { rows: [permissionApproved] } = await pg.query<{ result: { revisionId: string; state: string } }>(
        "SELECT public.app_admin_approve_permission_review($1, $2, 'human', $3) AS result",
        [permission.clientId, pendingRevisionId, permission.userId],
      );
      assert.deepEqual([permissionApproved?.result.revisionId, permissionApproved?.result.state], [pendingRevisionId, "active"]);
      assert.equal((await pg.query("SELECT 1 FROM pg_temp.oauth_clients UNION ALL SELECT 1 FROM pg_temp.integration_audit_events UNION ALL SELECT 1 FROM pg_temp.oauth_client_installs UNION ALL SELECT 1 FROM pg_temp.oauth_app_link_previews UNION ALL SELECT 1 FROM pg_temp.oauth_app_permission_revisions UNION ALL SELECT 1 FROM pg_temp.marketplace_review_outbox")).rows.length, 0);

      // App Admin's guard finds the marker without EXECUTE, and cannot call it.
      const { rows: [marker] } = await pg.query<{ found: boolean }>("SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS found", [MARKER]);
      assert.equal(marker?.found, true);
      assert.equal(await sqlState(pg.query(`SELECT ${MARKER}`)), "42501");
      // The decisions' outbox is the server's: App Admin's role neither reads nor writes it.
      assert.equal(await sqlState(pg.query("SELECT id FROM public.marketplace_review_outbox")), "42501");
      assert.equal(await sqlState(pg.query("UPDATE public.marketplace_review_outbox SET delivered_at = now()")), "42501");

      assert.equal(await sqlState(pg.query("SELECT client_secret_hash FROM public.oauth_clients")), "42501");
      assert.equal(await sqlState(pg.query("UPDATE public.oauth_clients SET publish_status = 'published'")), "42501");
      assert.equal(await sqlState(pg.query("UPDATE public.oauth_app_link_previews SET action_endpoint = pending_action_endpoint")), "42501");
      assert.equal(await sqlState(pg.query("DELETE FROM public.oauth_client_installs")), "42501");
      assert.equal(await sqlState(pg.query(
        "INSERT INTO public.integration_audit_events (id, event_type, event_category, outcome, source, actor_type, target_type) VALUES ($1, 'app.publish_approved', 'registration', 'success', 'api', 'human', 'app')",
        [randomUUID()],
      )), "42501");
      assert.equal(await sqlState(pg.query("SELECT public.reconcile_app_admin_privileges()")), "42501");
      assert.equal((await decide(second)).rows[0]?.result.status, "published");
    } finally {
      await pg.query("RESET ROLE");
    }

    const { rows } = await pg.query<{ id: string; publish_status: string; installs: number; audits: number }>(
      `SELECT c.id, c.publish_status,
              (SELECT count(*)::int FROM public.oauth_client_installs i WHERE i.client_id = c.id) AS installs,
              (SELECT count(*)::int FROM public.integration_audit_events e WHERE e.client_id = c.id AND e.event_type = 'app.publish_approved') AS audits
         FROM public.oauth_clients c WHERE c.id = ANY ($1::uuid[]) ORDER BY c.id`,
      [[first.clientId, second.clientId]],
    );
    assert.deepEqual(
      rows.map(({ publish_status, installs, audits }) => ({ publish_status, installs, audits })),
      [{ publish_status: "published", installs: 1, audits: 1 }, { publish_status: "published", installs: 1, audits: 1 }],
    );
    const { rows: [link] } = await pg.query<{ action_endpoint: string | null; pending_action_endpoint: string | null; audits: number }>(
      `SELECT p.action_endpoint, p.pending_action_endpoint,
              (SELECT count(*)::int FROM public.integration_audit_events e WHERE e.client_id = p.client_id AND e.event_type = 'app.action_endpoint_reviewed') AS audits
         FROM public.oauth_app_link_previews p WHERE p.client_id = $1`,
      [card.clientId],
    );
    assert.deepEqual(link, { action_endpoint: pendingActionEndpoint, pending_action_endpoint: null, audits: 1 });
    const { rows: [permissionState] } = await pg.query<{ state: string; current_groups: string[]; pending: string | null; audits: number }>(
      `SELECT r.state, c.outbound_current_groups AS current_groups, c.outbound_pending_revision_id AS pending,
              (SELECT count(*)::int FROM public.integration_audit_events e WHERE e.client_id = c.id AND e.event_type = 'app.outbound_permission_approved') AS audits
         FROM public.oauth_clients c JOIN public.oauth_app_permission_revisions r ON r.id = c.outbound_current_revision_id WHERE c.id = $1`,
      [permission.clientId],
    );
    assert.deepEqual(permissionState, { state: "active", current_groups: ["server"], pending: null, audits: 1 });
    // The decisions made under App Admin's role wrote their outbox rows (as the owner, inside the entries).
    const { rows: outbox } = await pg.query<{ client_id: string; kind: string; cause: string }>(
      "SELECT client_id, kind, cause FROM public.marketplace_review_outbox WHERE client_id = ANY ($1::uuid[]) ORDER BY seq",
      [[first.clientId, second.clientId, permission.clientId]],
    );
    // One row per Server with an installation before the decision: the first App's and the permission App's
    // source Servers; the second App had none.
    assert.deepEqual(outbox.map((row) => [row.client_id, row.kind, row.cause]), [
      [first.clientId, "permission_updates_changed", "app.publish_approved"],
      [permission.clientId, "permission_updates_changed", "app.outbound_permission_approved"],
    ]);
  } finally {
    await pg.close();
  }
});

test("app_admin_operator registers, approves and disables an official App but cannot write the registry, and its temporary tables cannot redirect the functions", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const { userId, clientId } = await publishRequest(pg, "published");
    // Registry writes need a person who is a Botiverse owner or admin now.
    const botiverseId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
    await pg.query("INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 'Botiverse', 'botiverse-fixture', $2)", [botiverseId, userId]);
    await pg.query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')", [botiverseId, userId]);
    const call = async (text: string, values: unknown[]) => (await pg.query<{ result: { status: string; revision: number; autoInstall: boolean } }>(text, values)).rows[0]!.result;

    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    try {
      for (const table of ["official_app_registry", "oauth_clients", "external_app_registrations", "integration_audit_events", "users", "agents", "servers", "server_members"]) {
        await pg.query(`CREATE TEMP TABLE ${table} (id uuid)`);
      }
      // The membership check is the functions' own; App Admin's role cannot call it.
      assert.equal(await sqlState(pg.query("SELECT public.official_app_registry_require_operator('human', $1)", [userId])), "42501");
      const registered = await call("SELECT public.official_app_registry_register($1, 'An official App.', 'human', $2) AS result", [clientId, userId]);
      assert.deepEqual([registered.status, registered.revision, registered.autoInstall], ["pending_review", 1, false]);
      const approved = await call("SELECT public.official_app_registry_update($1, 1, 'approved', NULL, 'human', $2) AS result", [clientId, userId]);
      assert.deepEqual([approved.status, approved.revision], ["approved", 2]);
      assert.equal((await pg.query("SELECT 1 FROM pg_temp.official_app_registry UNION ALL SELECT 1 FROM pg_temp.integration_audit_events")).rows.length, 0);

      assert.equal(await sqlState(pg.query("UPDATE public.official_app_registry SET auto_install = true")), "42501");
      assert.equal(await sqlState(pg.query("DELETE FROM public.official_app_registry")), "42501");
      assert.equal(await sqlState(pg.query(
        "INSERT INTO public.official_app_registry (oauth_client_id, client_key, publisher_server_id, purpose) VALUES ($1, 'fixture-key', $1, 'Direct write.')",
        [randomUUID()],
      )), "42501");
      assert.equal(await sqlState(pg.query("SELECT 1 FROM public.official_app_auto_install_states")), "42501");

      const disabled = await call("SELECT public.official_app_registry_update($1, 2, 'disabled', NULL, 'human', $2) AS result", [clientId, userId]);
      assert.deepEqual([disabled.status, disabled.revision], ["disabled", 3]);
    } finally {
      await pg.query("RESET ROLE");
    }

    const { rows } = await pg.query<{ status: string; revision: number; auto_install: boolean; installs: number; events: string[] }>(
      `SELECT r.status, r.revision, r.auto_install,
              (SELECT count(*)::int FROM public.oauth_client_installs i WHERE i.client_id = r.oauth_client_id) AS installs,
              (SELECT pg_catalog.array_agg(e.event_type ORDER BY (e.metadata->>'revision')::int) FROM public.integration_audit_events e WHERE e.client_id = r.oauth_client_id) AS events
         FROM public.official_app_registry r WHERE r.oauth_client_id = $1`,
      [clientId],
    );
    assert.deepEqual(rows, [{
      status: "disabled", revision: 3, auto_install: false, installs: 0,
      events: ["official_app.registry_created", "official_app.registry_updated", "official_app.registry_removed"],
    }]);
  } finally {
    await pg.close();
  }
});

test("app_admin_operator creates, edits and retires an MCP App template through the entries, each with its audit event", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const { userId } = await publishRequest(pg, "published");
    const { userId: outsider } = await publishRequest(pg, "published");
    await botiverseAdmin(pg, userId);
    type Entry = { id: string; key: string; name: string; logoUrl: string | null; status: string; revision: number; createdByUserId: string; updatedByUserId: string };
    const create = async (key: string, actorType: string, actorId: string, auditServerId: string | null = BOTIVERSE_SERVER_ID) => (await pg.query<{ result: Entry | null }>(
      `SELECT public.app_admin_create_mcp_app_template($1, 'Linear', 'Issue tracking.', 'https://linear.example.test/', NULL, 'Other', 'https://mcp.example.test/', 'oauth', $2, $3, $4) AS result`,
      [key, auditServerId, actorType, actorId],
    )).rows[0]!.result;
    const edit = async (id: string, revision: number) => (await pg.query<{ result: Entry | null }>(
      `SELECT public.app_admin_update_mcp_app_template($1, $2, 'Linear 2', 'Issue tracking.', 'https://linear.example.test/', 'https://cdn.example.test/l.png', 'Other', 'https://mcp.example.test/', 'oauth', $3, 'human', $4) AS result`,
      [id, revision, BOTIVERSE_SERVER_ID, userId],
    )).rows[0]!.result;
    const retire = async (id: string, revision: number) => (await pg.query<{ result: Entry | null }>(
      "SELECT public.app_admin_retire_mcp_app_template($1, $2, $3, 'human', $4) AS result",
      [id, revision, BOTIVERSE_SERVER_ID, userId],
    )).rows[0]!.result;

    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    let id: string;
    try {
      for (const table of ["mcp_app_templates", "integration_audit_events", "users", "servers", "server_members"]) {
        await pg.query(`CREATE TEMP TABLE ${table} (id uuid)`);
      }
      assert.equal(await sqlState(pg.query(`SELECT ${TEMPLATE_ENTRY.replace("(public.mcp_app_templates)", "(NULL::public.mcp_app_templates)")}`)), "42501");

      // The review entries' gate: a person who is a Botiverse owner or admin now.
      assert.equal(await sqlState(create("fixture-refused", "agent", userId)), "RVW07");
      assert.equal(await sqlState(create("fixture-refused", "human", outsider)), "RVW07");
      assert.equal(await sqlState(create("fixture-refused", "human", randomUUID())), "RVW01");
      assert.equal(await sqlState(create("fixture-refused", "human", userId, null)), "RVW01");

      const created = await create("fixture-template", "human", userId);
      assert.ok(created);
      id = created.id;
      assert.deepEqual(
        [created.key, created.status, created.revision, created.createdByUserId, created.updatedByUserId],
        ["fixture-template", "active", 1, userId, userId],
      );
      // A taken key, a stale revision, an already retired template: no row, no change, no audit event.
      assert.equal(await create("fixture-template", "human", userId), null);
      assert.equal(await edit(id, 7), null);
      const edited = await edit(id, 1);
      assert.deepEqual([edited?.name, edited?.logoUrl, edited?.revision], ["Linear 2", "https://cdn.example.test/l.png", 2]);
      assert.equal(await retire(id, 1), null);
      const retired = await retire(id, 2);
      assert.deepEqual([retired?.status, retired?.revision], ["retired", 3]);
      assert.equal(await retire(id, 3), null);
      assert.equal((await pg.query("SELECT 1 FROM pg_temp.mcp_app_templates UNION ALL SELECT 1 FROM pg_temp.integration_audit_events")).rows.length, 0);
    } finally {
      await pg.query("RESET ROLE");
    }

    const { rows: templates } = await pg.query("SELECT key FROM public.mcp_app_templates WHERE key LIKE 'fixture-%'");
    assert.deepEqual(templates, [{ key: "fixture-template" }]);
    const { rows: audits } = await pg.query<{ event_type: string; event_category: string; outcome: string; source: string; server_id: string; client_id: string | null; actor_type: string; actor_id: string; subject_type: string; target_type: string; target_id: string; metadata: Record<string, unknown>; diff: Record<string, { before: unknown; after: unknown }> | null }>(
      `SELECT event_type, event_category, outcome, source, server_id, client_id, actor_type, actor_id, subject_type, target_type, target_id, metadata, diff
         FROM public.integration_audit_events WHERE target_type = 'mcp_app_template' ORDER BY (metadata->>'revision')::int`,
    );
    assert.deepEqual(audits.map((audit) => audit.event_type), ["mcp_app.template_created", "mcp_app.template_updated", "mcp_app.template_retired"]);
    for (const audit of audits) {
      assert.deepEqual(
        [audit.event_category, audit.outcome, audit.source, audit.server_id, audit.client_id, audit.actor_type, audit.actor_id, audit.subject_type, audit.target_id],
        ["registration", "success", "web", BOTIVERSE_SERVER_ID, null, "human", userId, "system", id],
      );
    }
    assert.deepEqual(audits[0]?.metadata, { key: "fixture-template", name: "Linear", endpointUrl: "https://mcp.example.test/", authKind: "oauth", category: "Other", revision: 1 });
    assert.equal(audits[0]?.diff, null);
    assert.deepEqual(audits[1]?.metadata, { key: "fixture-template", revision: 2 });
    assert.deepEqual(Object.keys(audits[1]?.diff ?? {}).sort(), ["authKind", "category", "description", "endpointUrl", "homepageUrl", "logoUrl", "name"]);
    assert.deepEqual(audits[1]?.diff?.name, { before: "Linear", after: "Linear 2" });
    assert.deepEqual(audits[1]?.diff?.logoUrl, { before: null, after: "https://cdn.example.test/l.png" });
    assert.deepEqual(audits[2]?.metadata, { key: "fixture-template", revision: 3 });
  } finally {
    await pg.close();
  }
});

test("connected as app_admin_operator: the listed columns read, every other column and table is refused, and no table can be written", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const { rows: columns } = await pg.query<{ relation: string; column_name: string }>(
      `SELECT c.relname AS relation, a.attname AS column_name
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY 1, a.attnum`,
    );
    const firstColumn = new Map<string, string>();
    for (const { relation, column_name: column } of columns) if (!firstColumn.has(relation)) firstColumn.set(relation, column);
    const ident = (name: string) => `"${name}"`;
    // What must never be listed, by name: the review reads the list against this too.
    const credentialShaped = /secret|password|hash|token|email|webhook|credential|encrypted|api_key|code_challenge/;
    for (const [table, listed] of Object.entries(APP_ADMIN_READABLE_COLUMNS)) {
      for (const column of listed) assert.doesNotMatch(column, credentialShaped, `${table}.${column}`);
    }

    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    try {
      for (const { relation, column_name: column } of columns) {
        const read = pg.query(`SELECT ${ident(column)} FROM public.${ident(relation)} LIMIT 0`);
        if (APP_ADMIN_READABLE_COLUMNS[relation]?.includes(column)) await read;
        else assert.equal(await sqlState(read), "42501", `${relation}.${column}`);
      }
      // SELECT * reaches an unlisted column, so it is refused, except on the
      // tables whose columns are all listed today.
      for (const [table, listed] of Object.entries(APP_ADMIN_READABLE_COLUMNS)) {
        const all = columns.filter((column) => column.relation === table).length;
        if (listed.length === all) assert.ok(["integration_audit_events", "official_app_registry", "mcp_app_templates"].includes(table), table);
        else assert.equal(await sqlState(pg.query(`SELECT * FROM public.${ident(table)} LIMIT 0`)), "42501", `${table}: SELECT *`);
      }
      for (const [relation, column] of firstColumn) {
        const table = `public.${ident(relation)}`;
        for (const statement of [
          `INSERT INTO ${table} DEFAULT VALUES`,
          `UPDATE ${table} SET ${ident(column)} = ${ident(column)}`,
          `DELETE FROM ${table}`,
          `TRUNCATE ${table}`,
        ]) {
          assert.equal(await sqlState(pg.query(statement)), "42501", statement);
        }
      }
      assert.ok(firstColumn.has("users") && firstColumn.has("oauth_access_tokens") && firstColumn.has("mcp_app_templates"));
    } finally {
      await pg.query("RESET ROLE");
    }
  } finally {
    await pg.close();
  }
});

test("a stray grant on a decision body, the gate or the marker does not survive the reconciler", async () => {
  // The verifier refuses executable definer functions only (an invoker-rights
  // body does nothing without table privileges); the reconciler still revokes
  // each body and the gate by name.
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    const bodies = [PUBLISH_BODY, CARD_URL_BODY, PERMISSION_BODY, GATE, RENAME_BODY, LEGACY_KEYS, MARKER, TEMPLATE_ENTRY];
    for (const fn of bodies) await pg.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${APP_ADMIN_OPERATOR_ROLE}`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    for (const fn of bodies) {
      const { rows } = await pg.query<{ allowed: boolean }>("SELECT pg_catalog.has_function_privilege($1, $2, 'EXECUTE') AS allowed", [APP_ADMIN_OPERATOR_ROLE, fn]);
      assert.equal(rows[0]?.allowed, false, fn);
    }
  } finally {
    await pg.close();
  }
});

// Neon grants its pg_stat_statements views to PUBLIC, which has_table_privilege
// counts: staging's deploy failed on them (#proj-apps:#48). plpgsql stands in
// for the extension: PGlite has it installed, and ALTER EXTENSION ADD makes a
// view its member the way pg_stat_statements is.
async function withOperator() {
  const pg = await migrated();
  await pg.exec(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
  await reconcileAndVerifyAppAdminPrivileges(query(pg), { requireReconciler: true });
  return pg;
}
const extensionView = async (pg: PGlite, name: string) => {
  await pg.exec(`CREATE VIEW public.${name} AS SELECT 1 AS calls; ALTER EXTENSION plpgsql ADD VIEW public.${name};`);
};

test("an extension's view granted only to PUBLIC doesn't fail verification", async () => {
  const pg = await withOperator();
  await extensionView(pg, "fixture_stat_statements");
  await pg.exec("GRANT SELECT ON public.fixture_stat_statements TO PUBLIC");
  await verifyAppAdminPrivileges(query(pg));
});

test("an ordinary table granted to PUBLIC still fails verification", async () => {
  const pg = await withOperator();
  await pg.exec("CREATE TABLE public.fixture_open (id int); GRANT SELECT ON public.fixture_open TO PUBLIC");
  await assert.rejects(verifyAppAdminPrivileges(query(pg)), (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "unexpected:public.fixture_open");
});

test("an extension's view granted to the role itself, or to a role it belongs to, still fails verification", async () => {
  for (const grant of ["direct", "through_a_group"] as const) {
    const pg = await withOperator();
    await extensionView(pg, "fixture_stat_statements");
    await pg.exec("GRANT SELECT ON public.fixture_stat_statements TO PUBLIC");
    if (grant === "direct") {
      await pg.exec(`GRANT SELECT ON public.fixture_stat_statements TO ${APP_ADMIN_OPERATOR_ROLE}`);
    } else {
      await pg.exec(`CREATE ROLE fixture_group NOLOGIN; GRANT fixture_group TO ${APP_ADMIN_OPERATOR_ROLE}; GRANT SELECT ON public.fixture_stat_statements TO fixture_group`);
    }
    await assert.rejects(verifyAppAdminPrivileges(query(pg)), (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "unexpected:public.fixture_stat_statements", grant);
  }
});

test("one column of an extension's view granted to the role, or to a role it belongs to, still fails verification", async () => {
  for (const grant of ["direct", "through_a_group"] as const) {
    const pg = await withOperator();
    await extensionView(pg, "fixture_stat_statements");
    await pg.exec("GRANT SELECT ON public.fixture_stat_statements TO PUBLIC");
    if (grant === "direct") {
      await pg.exec(`GRANT SELECT (calls) ON public.fixture_stat_statements TO ${APP_ADMIN_OPERATOR_ROLE}`);
    } else {
      await pg.exec(`CREATE ROLE fixture_group NOLOGIN; GRANT fixture_group TO ${APP_ADMIN_OPERATOR_ROLE}; GRANT SELECT (calls) ON public.fixture_stat_statements TO fixture_group`);
    }
    await assert.rejects(verifyAppAdminPrivileges(query(pg)), (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "unexpected:public.fixture_stat_statements.calls:SELECT", grant);
  }
});

test("an extension's view with the default ACL, read through membership in its owner, still fails verification", async () => {
  const pg = await withOperator();
  await extensionView(pg, "fixture_stat_statements");
  await pg.exec(`CREATE ROLE fixture_owner NOLOGIN; ALTER VIEW public.fixture_stat_statements OWNER TO fixture_owner; GRANT fixture_owner TO ${APP_ADMIN_OPERATOR_ROLE}`);
  const acl = await pg.query<{ relacl: unknown }>("SELECT relacl FROM pg_class WHERE oid = 'public.fixture_stat_statements'::regclass");
  assert.equal(acl.rows[0]?.relacl, null, "the default ACL: no grant was written");
  await assert.rejects(verifyAppAdminPrivileges(query(pg)), (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "unexpected:public.fixture_stat_statements");
});

test("a write privilege on an extension's view through PUBLIC still fails verification", async () => {
  const pg = await withOperator();
  await extensionView(pg, "fixture_stat_statements");
  await pg.exec("GRANT SELECT, UPDATE ON public.fixture_stat_statements TO PUBLIC");
  await assert.rejects(verifyAppAdminPrivileges(query(pg)), (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "unexpected:public.fixture_stat_statements");
});

test("verification refuses every privilege beyond the contract, and the reconciler restores what it owns", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const role = APP_ADMIN_OPERATOR_ROLE;
    const cases: Array<[string, string, string]> = [
      ["table read", `GRANT SELECT ON public.users TO ${role}`, "unexpected:public.users"],
      ["column write", `GRANT UPDATE (name) ON public.oauth_clients TO ${role}`, "unexpected:public.oauth_clients"],
      ["a credential column", `GRANT SELECT (client_secret) ON public.oauth_clients TO ${role}`, "unexpected:public.oauth_clients.client_secret:SELECT"],
      ["a person's email", `GRANT SELECT (email) ON public.users TO ${role}`, "unexpected:public.users.email:SELECT"],
      ["a table nothing lists", `GRANT SELECT (id) ON public.agents TO ${role}`, "unexpected:public.agents.id:SELECT"],
      ["a listed column taken away", `REVOKE SELECT (name) ON public.users FROM ${role}`, "missing:public.users.name:SELECT"],
      ["missing template execute", `REVOKE EXECUTE ON FUNCTION ${RETIRE_TEMPLATE} FROM ${role}`, `missing:${RETIRE_TEMPLATE}:EXECUTE`],
      ["missing template update execute", `REVOKE EXECUTE ON FUNCTION ${UPDATE_TEMPLATE} FROM ${role}`, `missing:${UPDATE_TEMPLATE}:EXECUTE`],
      ["template delegation", `GRANT EXECUTE ON FUNCTION ${CREATE_TEMPLATE} TO ${role} WITH GRANT OPTION`, `unexpected:${CREATE_TEMPLATE}:EXECUTE WITH GRANT OPTION`],
      ["template write", `GRANT INSERT ON public.mcp_app_templates TO ${role}`, "unexpected:public.mcp_app_templates"],
      ["sequence", `CREATE SEQUENCE public.fixture_seq; GRANT USAGE ON SEQUENCE public.fixture_seq TO ${role}`, "unexpected:public.fixture_seq"],
      ["schema create", `GRANT CREATE ON SCHEMA public TO ${role}`, "unexpected:public:CREATE"],
      ["delegation", `GRANT EXECUTE ON FUNCTION ${DECIDE} TO ${role} WITH GRANT OPTION`, `unexpected:${DECIDE}:EXECUTE WITH GRANT OPTION`],
      ["missing execute", `REVOKE EXECUTE ON FUNCTION ${DECIDE} FROM ${role}`, `missing:${DECIDE}:EXECUTE`],
      ["missing card URL execute", `REVOKE EXECUTE ON FUNCTION ${DECIDE_CARD_URL} FROM ${role}`, `missing:${DECIDE_CARD_URL}:EXECUTE`],
      ["missing permission execute", `REVOKE EXECUTE ON FUNCTION ${APPROVE_PERMISSION} FROM ${role}`, `missing:${APPROVE_PERMISSION}:EXECUTE`],
      // The grant the earlier contracts gave: the publish body without the gate.
      ["the ungated publish body", `GRANT EXECUTE ON FUNCTION ${PUBLISH_BODY} TO ${role}`, "unexpected:marketplace_decide_publish_review(uuid,text,text,text,uuid,text):EXECUTE"],
      ["missing registry execute", `REVOKE EXECUTE ON FUNCTION ${UPDATE} FROM ${role}`, `missing:${UPDATE}:EXECUTE`],
      ["registry delegation", `GRANT EXECUTE ON FUNCTION ${REGISTER} TO ${role} WITH GRANT OPTION`, `unexpected:${REGISTER}:EXECUTE WITH GRANT OPTION`],
      ["registry write", `GRANT UPDATE (status) ON public.official_app_registry TO ${role}`, "unexpected:public.official_app_registry"],
      // Executable by PUBLIC, as every new function is by default.
      ["another definer function", "CREATE FUNCTION public.fixture_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'", "unexpected:fixture_definer():EXECUTE"],
    ];
    for (const [name, grant, reason] of cases) {
      await pg.exec(grant);
      assert.equal(await verifyRefusal(pg), reason, name);
      await pg.exec(`
        REVOKE ALL ON public.users, public.oauth_clients, public.official_app_registry, public.mcp_app_templates, public.agents FROM ${role};
        DROP SEQUENCE IF EXISTS public.fixture_seq;
        DROP FUNCTION IF EXISTS public.fixture_definer();
      `);
      // Schema and function grants are the reconciler's to restore.
      assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified", `${name}: reconciled`);
    }

    await pg.query("UPDATE public.app_admin_privilege_receipts SET applied_by = 'someone_else'");
    await assert.rejects(
      verifyAppAdminPrivilegeReceipt(query(pg)),
      (error: unknown) => error instanceof AppAdminPrivilegeError && error.reason === "privilege_receipt_principal_mismatch",
    );
  } finally {
    await pg.close();
  }
});

test("app_admin_change_client_key: a Botiverse admin changes a listed or official App's id through the one rename body", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const listed = await publishRequest(pg, "published");
    await botiverseAdmin(pg, listed.userId);
    const oldKey = await keyOfApp(pg, listed.clientId);
    const [server] = (await pg.query<{ server_id: string }>("SELECT server_id FROM oauth_clients WHERE id = $1", [listed.clientId])).rows;
    await pg.query(
      "INSERT INTO official_app_registry (oauth_client_id, client_key, publisher_server_id, purpose) VALUES ($1, $2, $3, 'Fixture')",
      [listed.clientId, oldKey, server.server_id],
    );
    const inReview = await publishRequest(pg, "in_review");
    const legacy = await publishRequest(pg, "published");
    await pg.query("UPDATE oauth_clients SET client_id = 'winbox' WHERE id = $1", [legacy.clientId]);
    const holder = await publishRequest(pg, "published");
    const change = (clientId: string, expected: string | null, next: string | null, actorType = "human", actorId = listed.userId, note: string | null = "Owner asked") =>
      pg.query<{ result: { changed: boolean; oldKey: string; newKey: string; previousKeyKept: boolean } }>(
        `SELECT ${CHANGE_CLIENT_KEY.replace(/\(.*/, "")}($1::uuid, $2, $3, $4, $5::uuid, $6) AS result`,
        [clientId, expected, next, actorType, actorId, note],
      );

    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    let answer;
    try {
      assert.equal(await sqlState(pg.query(`SELECT ${RENAME_BODY.replace(/\(.*/, "")}(gen_random_uuid(), 'nope-nope', true, 'human', gen_random_uuid(), 'web', NULL)`)), "42501");
      assert.equal(await sqlState(change(listed.clientId, oldKey, "new-listed", "agent")), "RVW07");
      assert.equal(await sqlState(change(listed.clientId, oldKey, "new-listed", "human", listed.userId, " ")), "RVW01");
      assert.equal(await sqlState(change(randomUUID(), oldKey, "new-listed")), "RVW02");
      assert.equal(await sqlState(change(listed.clientId, "stale-key", "new-listed")), "RVW05");
      assert.equal(await sqlState(change(inReview.clientId, await keyOfApp(pg, inReview.clientId), "new-review")), "RVW04");
      assert.equal(await sqlState(change(legacy.clientId, "winbox", "new-winbox")), "RVW04");
      assert.equal(await sqlState(change(listed.clientId, oldKey, "winbox-315c18")), "RVW04");
      assert.equal(await sqlState(change(listed.clientId, oldKey, await keyOfApp(pg, holder.clientId))), "CKY03");
      assert.equal(await sqlState(change(listed.clientId, oldKey, "Not Valid")), "CKY02");
      answer = (await change(listed.clientId, oldKey, "New-Listed")).rows[0].result;
    } finally {
      await pg.query("RESET ROLE");
    }
    assert.deepEqual(answer, { changed: true, oldKey, newKey: "new-listed", previousKeyKept: true });
    assert.equal(await keyOfApp(pg, listed.clientId), "new-listed");
    const { rows: [registry] } = await pg.query<{ client_key: string; revision: number; updated_by_user_id: string }>(
      "SELECT client_key, revision, updated_by_user_id FROM official_app_registry WHERE oauth_client_id = $1", [listed.clientId],
    );
    assert.deepEqual(registry, { client_key: "new-listed", revision: 2, updated_by_user_id: listed.userId });
    const { rows: aliases } = await pg.query<{ key: string; client_id: string }>("SELECT key, client_id FROM oauth_client_key_aliases");
    assert.deepEqual(aliases, [{ key: oldKey, client_id: listed.clientId }], "kept although the App was never used");
    const { rows: [audit] } = await pg.query<{ actor_type: string; actor_id: string; source: string; metadata: Record<string, unknown> }>(
      "SELECT actor_type, actor_id, source, metadata FROM integration_audit_events WHERE event_type = 'app.client_key_changed' AND client_id = $1", [listed.clientId],
    );
    assert.deepEqual(audit, {
      actor_type: "human", actor_id: listed.userId, source: "web",
      metadata: { clientKey: "new-listed", previousClientKey: oldKey, newClientKey: "new-listed", previousKeyKept: true, reviewNote: "Owner asked" },
    });
  } finally {
    await pg.close();
  }
});

test("the SQL copy of the legacy scope keys equals the TypeScript list", async () => {
  const pg = await migrated();
  try {
    const { rows: [row] } = await pg.query<{ keys: string[] }>(`SELECT ${LEGACY_KEYS} AS keys`);
    assert.deepEqual([...row.keys].sort(), Object.keys(LEGACY_OAUTH_SCOPE_ALLOWLIST).sort());
  } finally {
    await pg.close();
  }
});

test("template v2 gates humans and Agents, attributes actual actors, restores safely and retains restricted-role denials", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const { userId } = await publishRequest(pg, "published");
    await botiverseAdmin(pg, userId);
    const agentId = randomUUID(), memberId = randomUUID(), foreignId = randomUUID();
    const foreignServer = randomUUID();
    await pg.query("INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 'foreign', $2, $3)", [foreignServer, `other-${foreignServer.slice(0, 8)}`, userId]);
    for (const [id, server, role] of [[agentId, BOTIVERSE_SERVER_ID, 'admin'], [memberId, BOTIVERSE_SERVER_ID, 'member'], [foreignId, foreignServer, 'admin']]) {
      await pg.query("INSERT INTO agents (id, server_id, name) VALUES ($1, $2, $3)", [id, server, `agent-${id.slice(0, 8)}`]);
      // A foreign Agent's incorrectly attached membership is not sufficient.
      await pg.query("INSERT INTO server_agent_members (server_id, agent_id, role) VALUES ($1, $2, $3)", [BOTIVERSE_SERVER_ID, id, role]);
    }
    type Entry = { id: string; revision: number; status: string; oauthClientMode: string; createdByUserId: string | null; updatedByUserId: string | null };
    const create = async (key: string, kind: string, actor: string) => (await pg.query<{ result: Entry | null }>(
      "SELECT public.app_admin_create_mcp_app_template_v2($1, 'fixture', 'desc', 'https://example.test/', NULL, 'Other', 'https://example.test/?private=value', 'oauth', 'registered', $2, $3, $4) AS result",
      [key, BOTIVERSE_SERVER_ID, kind, actor],
    )).rows[0]!.result;
    const edit = async (id: string, revision: number, kind: string, actor: string) => (await pg.query<{ result: Entry | null }>(
      "SELECT public.app_admin_update_mcp_app_template_v2($1, $2, 'edit', 'desc', 'https://example.test/', NULL, 'Other', 'https://example.test/next?private=value', 'oauth', 'automatic', $3, $4, $5) AS result",
      [id, revision, BOTIVERSE_SERVER_ID, kind, actor],
    )).rows[0]!.result;
    const status = async (operation: "retire" | "restore", id: string, revision: number, kind: string, actor: string, endpoint = "https://example.test/next?private=value") => {
      const params = operation === "restore" ? [id, revision, endpoint, BOTIVERSE_SERVER_ID, kind, actor] : [id, revision, BOTIVERSE_SERVER_ID, kind, actor];
      const args = operation === "restore" ? "$1,$2,$3,$4,$5,$6" : "$1,$2,$3,$4,$5";
      return (await pg.query<{ result: Entry | null }>(`SELECT public.app_admin_${operation}_mcp_app_template_v2(${args}) AS result`, params)).rows[0]!.result;
    };
    let templateId = "";
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    try {
      await pg.exec("CREATE TEMP TABLE agents (id uuid); CREATE TEMP TABLE server_agent_members (agent_id uuid); CREATE TEMP TABLE users (id uuid); CREATE TEMP TABLE servers (id uuid)");
      for (const [kind, actor] of [["agent", memberId], ["agent", foreignId], ["agent", randomUUID()], ["human", randomUUID()]]) {
        assert.equal(await sqlState(create("denied", kind, actor)), "RVW07");
      }
      assert.equal(await sqlState(pg.query("SELECT public.mcp_template_require_manager('agent', $1)", [agentId])), "42501");
      assert.equal(await sqlState(pg.query("SELECT public.mcp_app_template_admin_entry_v2(NULL::public.mcp_app_templates)")), "42501");
      assert.equal(await sqlState(pg.query("UPDATE public.mcp_app_templates SET name = 'bad'")), "42501");
      assert.equal(await sqlState(pg.query("SELECT password_hash FROM public.users LIMIT 1")), "42501");
      assert.equal(await sqlState(pg.query("SELECT public.app_admin_decide_publish_review(NULL, 'approve', NULL, 'agent', $1, NULL)", [agentId])), "RVW07");
      const created = await create("agent-fixture", "agent", agentId);
      assert.ok(created); templateId = created.id;
      assert.deepEqual([created.revision, created.oauthClientMode, created.createdByUserId, created.updatedByUserId], [1, "registered", null, null]);
      assert.equal(await create("agent-fixture", "agent", agentId), null);
      assert.equal(await edit(templateId, 9, "agent", agentId), null);
      const edited = await edit(templateId, 1, "agent", agentId);
      assert.deepEqual([edited?.revision, edited?.oauthClientMode, edited?.updatedByUserId], [2, "automatic", null]);
      assert.equal((await status("retire", templateId, 2, "agent", agentId))?.status, "retired");
      assert.equal(await status("restore", templateId, 3, "agent", agentId, "https://example.test/stale"), null);
      assert.equal((await status("restore", templateId, 3, "human", userId))?.status, "active");
    } finally { await pg.query("RESET ROLE"); }
    const events = (await pg.query<{ actor_type: string; actor_id: string; event_type: string; source: string; metadata: unknown; diff: unknown }>(
      "SELECT actor_type, actor_id, event_type, source, metadata, diff FROM public.integration_audit_events WHERE target_id = $1 ORDER BY (metadata->>'revision')::integer", [templateId],
    )).rows;
    assert.deepEqual(events.map(e => [e.actor_type, e.actor_id, e.event_type, e.source]), [
      ["agent", agentId, "mcp_app.template_created", "api"], ["agent", agentId, "mcp_app.template_updated", "api"],
      ["agent", agentId, "mcp_app.template_retired", "api"], ["human", userId, "mcp_app.template_restored", "web"],
    ]);
    assert.ok(!JSON.stringify(events).includes("private=value"), "audit must not retain endpoint query values");
    await pg.query("UPDATE public.server_agent_members SET role = 'member' WHERE agent_id = $1", [agentId]);
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    assert.equal(await sqlState(create("demoted", "agent", agentId)), "RVW07");
    await pg.query("RESET ROLE");
  } finally { await pg.close(); }
});

test("template manager probe is a read-only restricted-role boolean matching the locked write gate", async () => {
  const pg = await migrated();
  try {
    await pg.query(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    assert.equal(await reconcileAndVerifyAppAdminPrivileges(query(pg)), "verified");
    const { userId } = await publishRequest(pg, "published");
    const { userId: outsider } = await publishRequest(pg, "published");
    await botiverseAdmin(pg, userId);
    const agent = randomUUID(), foreign = randomUUID(), otherServer = randomUUID();
    await pg.query("INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 'other', $2, $3)", [otherServer, `other-${otherServer.slice(0,8)}`, userId]);
    await pg.query("INSERT INTO agents (id, server_id, name) VALUES ($1, $2, 'probe-agent'), ($3, $4, 'foreign-agent')", [agent, BOTIVERSE_SERVER_ID, foreign, otherServer]);
    await pg.query("INSERT INTO server_agent_members (server_id, agent_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')", [BOTIVERSE_SERVER_ID, agent, foreign]);
    const probe = async (kind: string, id: string | null) => (await pg.query<{ allowed: boolean }>("SELECT public.app_admin_can_manage_mcp_templates($1,$2) AS allowed", [kind, id])).rows[0]!.allowed;
    const metadata = (await pg.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] }>("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid='public.app_admin_can_manage_mcp_templates(text,uuid)'::regprocedure")).rows[0]!;
    assert.deepEqual(metadata, { prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'] });
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    try {
      await pg.exec("CREATE TEMP TABLE servers (id uuid); CREATE TEMP TABLE users (id uuid); CREATE TEMP TABLE agents (id uuid); CREATE TEMP TABLE server_members (server_id uuid); CREATE TEMP TABLE server_agent_members (agent_id uuid)");
      assert.equal(await probe('human', userId), true);
      assert.equal(await probe('agent', agent), true);
      assert.equal(await probe('human', outsider), false);
      assert.equal(await probe('agent', foreign), false);
      assert.equal(await probe('human', null), false);
      assert.equal(await probe('service', userId), false);
      assert.equal(await sqlState(pg.query("SELECT public.mcp_template_require_manager('agent',$1)", [agent])), '42501');
      assert.equal(await sqlState(pg.query("SELECT public.mcp_template_require_audit_server($1)", [BOTIVERSE_SERVER_ID])), '42501');
      assert.equal(await sqlState(pg.query("SELECT deleted_at FROM public.agents LIMIT 0")), '42501');
    } finally { await pg.query('RESET ROLE'); }
    await pg.exec("DROP TABLE pg_temp.servers, pg_temp.users, pg_temp.agents, pg_temp.server_members, pg_temp.server_agent_members");
    await pg.query("UPDATE public.server_agent_members SET role='member' WHERE agent_id=$1", [agent]);
    await pg.query("UPDATE public.users SET retired_at=now() WHERE id=$1", [userId]);
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    assert.equal(await probe('agent', agent), false);
    assert.equal(await probe('human', userId), false);
    await pg.query('RESET ROLE');
    await pg.query("UPDATE public.server_agent_members SET role='admin' WHERE agent_id=$1", [agent]);
    await pg.query("UPDATE public.agents SET deleted_at=now() WHERE id=$1", [agent]);
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    assert.equal(await probe('agent', agent), false);
    await pg.query('RESET ROLE');
    await pg.query("UPDATE public.agents SET deleted_at=NULL WHERE id=$1", [agent]);
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    assert.equal(await probe('agent', agent), true);
    await pg.query('RESET ROLE');
    await pg.query("UPDATE public.servers SET deleted_at=now() WHERE id=$1", [BOTIVERSE_SERVER_ID]);
    await pg.query(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`);
    assert.equal(await probe('agent', agent), false);
    await pg.query('RESET ROLE');
  } finally { await pg.close(); }
});
