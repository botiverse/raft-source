// A writer and account retirement lock Server/user rows in opposite orders.
// Requires an isolated loopback PostgreSQL database named below.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { test } from "vitest";

const rawUrl = process.env.MCP_RETIREMENT_FENCE_TEST_URL;
const required = process.env.MCP_RETIREMENT_FENCE_REAL_PG_REQUIRED === "1";
const serverId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test.skipIf(!rawUrl && !required)("template entry avoids account-retirement lock cycle", async () => {
  assert.ok(rawUrl, "MCP_RETIREMENT_FENCE_TEST_URL required");
  const url = new URL(rawUrl);
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) && url.pathname === "/cardy_mcp_retirement_test", "use the dedicated throwaway loopback database");
  const admin = new pg.Client({ connectionString: rawUrl });
  const writer = new pg.Client({ connectionString: rawUrl });
  const retire = new pg.Client({ connectionString: rawUrl });
  await Promise.all([admin.connect(), writer.connect(), retire.connect()]);
  const role = `mcp_retire_${randomUUID().replaceAll("-", "")}`;
  let roleCreated = false, tablesCreated = false, functionsCreated = false;
  try {
    const names = ["mcp_template_require_manager", "mcp_template_require_audit_server", "mcp_app_template_admin_entry_v2", "app_admin_create_mcp_app_template_v2", "app_admin_update_mcp_app_template_v2", "app_admin_retire_mcp_app_template_v2", "app_admin_restore_mcp_app_template_v2"];
    const prior = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[])", [names]);
    assert.equal(prior.rows[0]?.count, "0", "fixture functions must not preexist");
    await admin.query(`CREATE ROLE "${role}" NOLOGIN`); roleCreated = true;
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
      CREATE TABLE public.integration_audit_events (id uuid PRIMARY KEY, server_id uuid REFERENCES public.servers(id), client_id uuid, event_type text,
        event_category text, outcome text, source text, actor_type text, actor_id uuid, subject_type text, subject_id uuid,
        target_type text, target_id uuid, metadata jsonb, diff jsonb);
    `); tablesCreated = true;
    const baseline = readFileSync(new URL("../../drizzle/0664_app_admin_mcp_template_agents.sql", import.meta.url), "utf8");
    await admin.query(baseline.slice(0, baseline.indexOf("CREATE OR REPLACE FUNCTION public.reconcile_app_admin_privileges()")));
    functionsCreated = true;
    await admin.query(`GRANT EXECUTE ON FUNCTION public.app_admin_create_mcp_app_template_v2(text,text,text,text,text,text,text,text,text,uuid,text,uuid) TO "${role}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION public.app_admin_update_mcp_app_template_v2(uuid,integer,text,text,text,text,text,text,text,text,uuid,text,uuid) TO "${role}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION public.app_admin_retire_mcp_app_template_v2(uuid,integer,uuid,text,uuid) TO "${role}"`);
    await admin.query(`GRANT EXECUTE ON FUNCTION public.app_admin_restore_mcp_app_template_v2(uuid,integer,text,uuid,text,uuid) TO "${role}"`);
    const human = randomUUID();
    await admin.query("INSERT INTO public.servers VALUES ($1,NULL)", [serverId]);
    await admin.query("INSERT INTO public.users VALUES ($1,NULL)", [human]);
    await admin.query("INSERT INTO public.server_members VALUES ($1,$2,'admin')", [serverId, human]);
    await writer.query("SET deadlock_timeout='100ms'");
    await retire.query("SET deadlock_timeout='5s'");
    await writer.query(`SET ROLE "${role}"`);
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const retirePid = (await retire.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    async function expectBlocked(pid: number, blocker: number) {
      for (let i = 0; i < 200; i++) {
        if ((await admin.query<{ blocked: boolean }>("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [pid, blocker])).rows[0]?.blocked) return;
        await wait(10);
      }
      assert.fail("retirement did not wait for the writer's Server lock");
    }
    async function race(expected: string) {
      // Writer holds Server first, as v2 does. Retirement owns user first and
      // then waits to hand over the Server, exactly as the cleanup service.
      await writer.query("BEGIN");
      await writer.query("RESET ROLE");
      await writer.query("SELECT id FROM public.servers WHERE id=$1 FOR SHARE", [serverId]);
      await writer.query(`SET LOCAL ROLE "${role}"`);
      await retire.query("BEGIN");
      await retire.query("SELECT id FROM public.users WHERE id=$1 FOR UPDATE", [human]);
      const handover = retire.query("SELECT id FROM public.servers WHERE id=$1 FOR UPDATE", [serverId]);
      await expectBlocked(retirePid, writerPid);
      const result = await writer.query("SELECT public.app_admin_create_mcp_app_template_v2('fixture','name','desc','https://example.test',NULL,'Other','https://example.test/mcp','oauth','either',$1,'human',$2)", [serverId, human]).then(() => 'unexpected-success', (error: {code?: string}) => error.code);
      assert.equal(result, expected);
      await writer.query("ROLLBACK");
      await handover;
      await retire.query("COMMIT");
      assert.equal((await admin.query<{n: number}>("SELECT count(*)::int AS n FROM public.mcp_app_templates")).rows[0]!.n, 0);
      assert.equal((await admin.query<{n: number}>("SELECT count(*)::int AS n FROM public.integration_audit_events")).rows[0]!.n, 0);
    }
    await race("40P01"); // 0664's old gate: deadlock, no safe fail-fast.
    const next = readFileSync(new URL("../../drizzle/0666_app_admin_mcp_manager_probe.sql", import.meta.url), "utf8");
    const gateOnly = next.slice(next.indexOf("CREATE OR REPLACE FUNCTION public.mcp_template_require_manager"), next.indexOf("-- The audit Server can differ"));
    await admin.query(gateOnly); // NOWAIT identity rows alone are insufficient.
    const auditServer = randomUUID(), agent = randomUUID();
    await admin.query("INSERT INTO public.servers VALUES ($1,NULL)", [auditServer]);
    await admin.query("INSERT INTO public.agents VALUES ($1,$2,NULL)", [agent, serverId]);
    await admin.query("INSERT INTO public.server_agent_members VALUES ($1,$2,'admin')", [serverId, agent]);
    async function auditRace(mode: "old" | "no-fk" | "fixed", operation: "create" | "update" | "retire" | "restore" = "create") {
      const templateId = randomUUID();
      if (operation !== "create") {
        await admin.query("INSERT INTO public.mcp_app_templates(id,key,status,endpoint_url) VALUES($1,$2,$3,'https://example.test/mcp')", [templateId, `seed-${templateId}`, operation === "restore" ? "retired" : "active"]);
      }
      await retire.query("BEGIN");
      await retire.query("SELECT id FROM public.users WHERE id=$1 FOR UPDATE", [human]);
      await retire.query("SELECT id FROM public.servers WHERE id=$1 FOR UPDATE", [auditServer]);
      await writer.query("BEGIN");
      const statement = operation === "create"
        ? "SELECT public.app_admin_create_mcp_app_template_v2('agent-fixture','name','desc','https://example.test',NULL,'Other','https://example.test/mcp','oauth','either',$1,'agent',$2)"
        : operation === "update"
          ? "SELECT public.app_admin_update_mcp_app_template_v2($3,1,'name','desc','https://example.test',NULL,'Other','https://example.test/mcp','oauth','either',$1,'agent',$2)"
          : operation === "retire"
            ? "SELECT public.app_admin_retire_mcp_app_template_v2($3,1,$1,'agent',$2)"
            : "SELECT public.app_admin_restore_mcp_app_template_v2($3,1,'https://example.test/mcp',$1,'agent',$2)";
      const write = writer.query(statement, operation === "create" ? [auditServer, agent] : [auditServer, agent, templateId])
        .then(() => "ok", async (error: { code?: string }) => { await writer.query("ROLLBACK"); return error.code; });
      if (mode === "fixed") {
        assert.equal(await write, "55P03");
        assert.equal((await retire.query("UPDATE public.agents SET deleted_at=now() WHERE id=$1", [agent])).rowCount, 1);
      } else if (mode === "old") {
        await expectBlocked(writerPid, retirePid);
        const transfer = retire.query("UPDATE public.agents SET deleted_at=now() WHERE id=$1", [agent]);
        assert.equal(await write, "40P01");
        assert.equal((await transfer).rowCount, 1);
      } else {
        assert.equal(await write, "ok");
        const transfer = retire.query("UPDATE public.agents SET deleted_at=now() WHERE id=$1", [agent]);
        await expectBlocked(retirePid, writerPid);
        await writer.query("ROLLBACK");
        assert.equal((await transfer).rowCount, 1);
      }
      await retire.query("ROLLBACK");
      const rows = (await admin.query<{id: string; revision: number; status: string}>("SELECT id, revision, status FROM public.mcp_app_templates")).rows;
      if (operation === "create") assert.equal(rows.length, 0);
      else assert.deepEqual(rows, [{ id: templateId, revision: 1, status: operation === "restore" ? "retired" : "active" }]);
      assert.equal((await admin.query<{n: number}>("SELECT count(*)::int AS n FROM public.integration_audit_events")).rows[0]!.n, 0);
      if (operation !== "create") await admin.query("DELETE FROM public.mcp_app_templates WHERE id=$1", [templateId]);
    }
    for (const operation of ["create", "update", "retire", "restore"] as const) await auditRace("old", operation);
    await admin.query("ALTER TABLE public.integration_audit_events DROP CONSTRAINT integration_audit_events_server_id_fkey");
    await auditRace("no-fk");
    await admin.query("ALTER TABLE public.integration_audit_events ADD CONSTRAINT integration_audit_events_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id)");
    const fixed = next.slice(next.indexOf("CREATE OR REPLACE FUNCTION public.mcp_template_require_manager"), next.indexOf("CREATE FUNCTION public.app_admin_can_manage_mcp_templates"));
    await admin.query(fixed);
    await race("55P03"); // new gate: writer fails fast, retirement completes.
    for (const operation of ["create", "update", "retire", "restore"] as const) await auditRace("fixed", operation);
  } finally {
    await Promise.allSettled([writer.end(), retire.end()]);
    try {
      if (roleCreated) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
      if (functionsCreated) await admin.query(`
        DROP FUNCTION IF EXISTS public.app_admin_create_mcp_app_template_v2(text,text,text,text,text,text,text,text,text,uuid,text,uuid);
        DROP FUNCTION IF EXISTS public.app_admin_update_mcp_app_template_v2(uuid,integer,text,text,text,text,text,text,text,text,uuid,text,uuid);
        DROP FUNCTION IF EXISTS public.app_admin_retire_mcp_app_template_v2(uuid,integer,uuid,text,uuid);
        DROP FUNCTION IF EXISTS public.app_admin_restore_mcp_app_template_v2(uuid,integer,text,uuid,text,uuid);
        DROP FUNCTION IF EXISTS public.mcp_app_template_admin_entry_v2(public.mcp_app_templates);
        DROP FUNCTION IF EXISTS public.mcp_template_require_manager(text,uuid);
          DROP FUNCTION IF EXISTS public.mcp_template_require_audit_server(uuid);
      `);
      if (tablesCreated) await admin.query(`DROP TABLE public.integration_audit_events, public.mcp_app_templates, public.server_agent_members, public.server_members, public.agents, public.users, public.servers`);
    } finally { await admin.end(); }
  }
});
