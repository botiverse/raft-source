// Concurrent PostgreSQL is required: PGlite cannot prove conflicting locks.
// Set MCP_TEMPLATE_FENCE_TEST_URL only to an isolated loopback database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { test } from "vitest";

const rawUrl = process.env.MCP_TEMPLATE_FENCE_TEST_URL;
const required = process.env.MCP_TEMPLATE_FENCE_REAL_PG_REQUIRED === "1";
const serverId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test.skipIf(!rawUrl && !required)("template writes serialize against identity, membership and server revocation", async () => {
  assert.ok(rawUrl, "MCP_TEMPLATE_FENCE_TEST_URL required");
  const url = new URL(rawUrl);
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) && url.pathname === "/cardy_mcp_fence_test", "use the dedicated throwaway loopback database");
  const admin = new pg.Client({ connectionString: rawUrl });
  const writer = new pg.Client({ connectionString: rawUrl });
  const revoker = new pg.Client({ connectionString: rawUrl });
  await Promise.all([admin.connect(), writer.connect(), revoker.connect()]);
  const role = `mcp_fence_${randomUUID().replaceAll("-", "")}`;
  let roleCreated = false, tablesCreated = false, functionsCreated = false;
  try {
    const prior = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [["mcp_template_require_manager", "mcp_template_require_audit_server", "mcp_app_template_admin_entry_v2", "app_admin_create_mcp_app_template_v2", "app_admin_update_mcp_app_template_v2", "app_admin_retire_mcp_app_template_v2", "app_admin_restore_mcp_app_template_v2"]],
    );
    assert.equal(prior.rows[0]?.count, "0", "fixture functions must not preexist");
    await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
    roleCreated = true;
    await admin.query(`
      CREATE TABLE public.servers (id uuid PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE public.users (id uuid PRIMARY KEY, retired_at timestamptz);
      CREATE TABLE public.agents (id uuid PRIMARY KEY, server_id uuid NOT NULL, deleted_at timestamptz);
      CREATE TABLE public.server_members (server_id uuid, user_id uuid, role text, PRIMARY KEY(server_id,user_id));
      CREATE TABLE public.server_agent_members (server_id uuid, agent_id uuid, role text, PRIMARY KEY(server_id,agent_id));
      CREATE TABLE public.mcp_app_templates (id uuid PRIMARY KEY, key text UNIQUE, name text, description text,
        homepage_url text, logo_url text, category text, endpoint_url text, auth_kind text, oauth_client_mode text,
        status text, revision integer NOT NULL DEFAULT 1, created_by_user_id uuid, updated_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.integration_audit_events (id uuid PRIMARY KEY, server_id uuid, client_id uuid, event_type text,
        event_category text, outcome text, source text, actor_type text, actor_id uuid, subject_type text, subject_id uuid,
        target_type text, target_id uuid, metadata jsonb, diff jsonb);
    `);
    tablesCreated = true;
    const migration = readFileSync(new URL("../../drizzle/0664_app_admin_mcp_template_agents.sql", import.meta.url), "utf8");
    const prefix = migration.slice(0, migration.indexOf("CREATE OR REPLACE FUNCTION public.reconcile_app_admin_privileges()"));
    await admin.query(prefix);
    functionsCreated = true;
    const fix = readFileSync(new URL("../../drizzle/0666_app_admin_mcp_manager_probe.sql", import.meta.url), "utf8");
    const gate = fix.slice(fix.indexOf("CREATE OR REPLACE FUNCTION public.mcp_template_require_manager"), fix.indexOf("CREATE FUNCTION public.app_admin_can_manage_mcp_templates"));
    await admin.query(gate);
    await admin.query(`GRANT EXECUTE ON FUNCTION public.app_admin_create_mcp_app_template_v2(text,text,text,text,text,text,text,text,text,uuid,text,uuid) TO "${role}"`);
    const human = randomUUID(), agent = randomUUID();
    await admin.query("INSERT INTO public.servers VALUES ($1, NULL)", [serverId]);
    await admin.query("INSERT INTO public.users VALUES ($1, NULL)", [human]);
    await admin.query("INSERT INTO public.agents VALUES ($1, $2, NULL)", [agent, serverId]);
    await admin.query("INSERT INTO public.server_members VALUES ($1,$2,'admin')", [serverId, human]);
    await admin.query("INSERT INTO public.server_agent_members VALUES ($1,$2,'admin')", [serverId, agent]);
    await writer.query(`SET ROLE "${role}"`);
    await Promise.all([writer.query("SET lock_timeout = '5s'"), revoker.query("SET lock_timeout = '5s'")]);
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const revokerPid = (await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    async function expectBlocked(pid: number, blocker: number) {
      for (let i = 0; i < 200; i++) {
        const row = (await admin.query<{ blocked: boolean }>(
          "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [pid, blocker],
        )).rows[0];
        if (row?.blocked) return;
        await wait(10);
      }
      assert.fail(`backend ${pid} never blocked on ${blocker}`);
    }
    let counter = 0;
    const create = (kind: string, actor: string) => writer.query(
      "SELECT public.app_admin_create_mcp_app_template_v2($1,'fixture','desc','https://example.test/',NULL,'Other','https://example.test/mcp','oauth','either',$2,$3,$4)",
      [`key-${counter++}`, serverId, kind, actor],
    );
    const cases = [
      { kind: "agent", actor: agent, revoke: "UPDATE public.server_agent_members SET role='member' WHERE agent_id=$1", reset: "UPDATE public.server_agent_members SET role='admin' WHERE agent_id=$1", id: agent },
      { kind: "agent", actor: agent, revoke: "UPDATE public.agents SET deleted_at=now() WHERE id=$1", reset: "UPDATE public.agents SET deleted_at=NULL WHERE id=$1", id: agent },
      { kind: "human", actor: human, revoke: "UPDATE public.server_members SET role='member' WHERE user_id=$1", reset: "UPDATE public.server_members SET role='admin' WHERE user_id=$1", id: human },
      { kind: "human", actor: human, revoke: "UPDATE public.users SET retired_at=now() WHERE id=$1", reset: "UPDATE public.users SET retired_at=NULL WHERE id=$1", id: human },
      { kind: "agent", actor: agent, revoke: "UPDATE public.servers SET deleted_at=now() WHERE id=$1", reset: "UPDATE public.servers SET deleted_at=NULL WHERE id=$1", id: serverId },
    ];
    for (const c of cases) {
      // A write that locked current authority first must finish before revocation.
      await writer.query("BEGIN");
      await create(c.kind, c.actor);
      await revoker.query("BEGIN");
      const revoke = revoker.query(c.revoke, [c.id]);
      await expectBlocked(revokerPid, writerPid);
      await writer.query("COMMIT");
      await revoke;
      await revoker.query("COMMIT");
      await assert.rejects(create(c.kind, c.actor), (e: unknown) => (e as { code?: string }).code === "RVW07");
      await admin.query(c.reset, [c.id]);
      // Revocation already holds the row: fail fast and retry only after it
      // commits; the subsequent authority check must see the revocation.
      await revoker.query("BEGIN");
      await revoker.query(c.revoke, [c.id]);
      await writer.query("BEGIN");
      await assert.rejects(create(c.kind, c.actor), (e: unknown) => (e as { code?: string }).code === "55P03", c.revoke);
      await writer.query("ROLLBACK");
      await revoker.query("COMMIT");
      await assert.rejects(create(c.kind, c.actor), (e: unknown) => (e as { code?: string }).code === "RVW07", c.revoke);
      await admin.query(c.reset, [c.id]);
    }
  } finally {
    await Promise.allSettled([writer.end(), revoker.end()]);
    try {
      if (roleCreated) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
      if (functionsCreated) {
        // These objects were created only after CREATE TABLE established the
        // dedicated database was empty. Never drop a pre-existing role/table.
        await admin.query(`
          DROP FUNCTION IF EXISTS public.app_admin_create_mcp_app_template_v2(text,text,text,text,text,text,text,text,text,uuid,text,uuid);
          DROP FUNCTION IF EXISTS public.app_admin_update_mcp_app_template_v2(uuid,integer,text,text,text,text,text,text,text,text,uuid,text,uuid);
          DROP FUNCTION IF EXISTS public.app_admin_retire_mcp_app_template_v2(uuid,integer,uuid,text,uuid);
          DROP FUNCTION IF EXISTS public.app_admin_restore_mcp_app_template_v2(uuid,integer,text,uuid,text,uuid);
          DROP FUNCTION IF EXISTS public.mcp_app_template_admin_entry_v2(public.mcp_app_templates);
          DROP FUNCTION IF EXISTS public.mcp_template_require_manager(text,uuid);
          DROP FUNCTION IF EXISTS public.mcp_template_require_audit_server(uuid);
        `);
      }
      if (tablesCreated) {
        await admin.query(`DROP TABLE public.integration_audit_events, public.mcp_app_templates, public.server_agent_members,
          public.server_members, public.agents, public.users, public.servers`);
      }
    } finally { await admin.end(); }
  }
});
