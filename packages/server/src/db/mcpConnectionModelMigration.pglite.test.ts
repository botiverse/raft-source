import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";

/**
 * MCP Apps connection model (0408–0410) applied to rows written by the code that is in production
 * before this release, and to writes that code keeps making while the deploy rolls.
 *
 * What must hold after the migrations, with no data rewrite beyond the documented backfills:
 *   · every existing credential is its App's server default, so every Agent keeps working
 *   · every existing assignment follows the default; one that was switched off stays off
 *   · an App can hold several Connections (the one-credential-per-App index is gone), but only one
 *     of them can be the server default
 *   · an older binary updating `enabled` / `allowed_tools` never disturbs the new columns
 */

const migrationUrl = (tag: string) => new URL(`../../drizzle/${tag}.sql`, import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((entry) => entry.tag);

const FIRST = "0408_managed_mcp_app_profile";
const LAST = "0410_managed_mcp_connection_binding";
const firstIndex = tags.indexOf(FIRST);
const lastIndex = tags.indexOf(LAST);

async function apply(pg: PGlite, applied: readonly string[]): Promise<void> {
  for (const tag of applied) {
    await pg.exec(`BEGIN;\n${readFileSync(migrationUrl(tag), "utf8")}\n;COMMIT;`);
  }
}

const USER = "00000000-0000-4000-8000-000000000001";
const SERVER = "00000000-0000-4000-8000-0000000000a1";
const AGENT_PLAIN = "00000000-0000-4000-8000-0000000000c1";
const AGENT_TOOLS = "00000000-0000-4000-8000-0000000000c2";
const AGENT_OFF = "00000000-0000-4000-8000-0000000000c3";
const MCP_HEADERS = "00000000-0000-4000-8000-0000000000d1";
const MCP_OAUTH = "00000000-0000-4000-8000-0000000000d2";
const CRED_HEADERS = "00000000-0000-4000-8000-0000000000e1";
const CRED_OAUTH = "00000000-0000-4000-8000-0000000000e2";

test("the migrations under test are in the journal, in order", () => {
  assert.notEqual(firstIndex, -1);
  assert.notEqual(lastIndex, -1);
  assert.ok(firstIndex < lastIndex);
});

async function migratedFromProductionShape(): Promise<PGlite> {
  const pg = new PGlite();
  await apply(pg, tags.slice(0, firstIndex));
  // Rows exactly as the code in production writes them today: one credential per MCP server and
  // assignments that only know `enabled` and `allowed_tools`.
  await pg.exec(`
    INSERT INTO users (id, email, name, password_hash)
      VALUES ('${USER}', 'fixture@example.test', 'Fixture', 'fixture-value-not-a-credential');
    INSERT INTO servers (id, name, slug, owner_id) VALUES ('${SERVER}', 'S', 's', '${USER}');
    INSERT INTO agents (id, server_id, name) VALUES
      ('${AGENT_PLAIN}', '${SERVER}', 'plain'),
      ('${AGENT_TOOLS}', '${SERVER}', 'tools'),
      ('${AGENT_OFF}', '${SERVER}', 'off');
    INSERT INTO managed_mcp_servers (id, server_id, name, provider, auth_mode, oauth_status, endpoint_url) VALUES
      ('${MCP_HEADERS}', '${SERVER}', 'Docs', 'custom', 'headers', 'connected', 'https://docs.example.test/mcp'),
      ('${MCP_OAUTH}', '${SERVER}', 'Notion', 'notion', 'oauth', 'connected', 'https://mcp.notion.com/mcp');
    INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, header_names) VALUES
      ('${CRED_HEADERS}', '${SERVER}', '${MCP_HEADERS}', '["X-Api-Key"]'),
      ('${CRED_OAUTH}', '${SERVER}', '${MCP_OAUTH}', '[]');
    INSERT INTO managed_mcp_assignments (server_id, agent_id, mcp_server_id, enabled, allowed_tools) VALUES
      ('${SERVER}', '${AGENT_TOOLS}', '${MCP_HEADERS}', true, '["search"]'),
      ('${SERVER}', '${AGENT_OFF}', '${MCP_HEADERS}', false, NULL);
  `);
  await apply(pg, tags.slice(firstIndex, lastIndex + 1));
  return pg;
}

test("existing credentials become their App's server default, with status taken from the App", async () => {
  const pg = await migratedFromProductionShape();
  const { rows } = await pg.query<{ id: string; is_server_default: boolean; auth_kind: string | null; auth_status: string; name: string | null }>(
    `SELECT id, is_server_default, auth_kind, auth_status, name FROM managed_mcp_credentials ORDER BY id`,
  );
  assert.deepEqual(rows, [
    { id: CRED_HEADERS, is_server_default: true, auth_kind: "headers", auth_status: "ready", name: "Docs" },
    { id: CRED_OAUTH, is_server_default: true, auth_kind: "oauth", auth_status: "ready", name: "Notion" },
  ]);
  const { rows: apps } = await pg.query<{ id: string; source_kind: string; template_key: string | null }>(
    `SELECT id, source_kind, template_key FROM managed_mcp_servers ORDER BY id`,
  );
  assert.deepEqual(apps, [
    { id: MCP_HEADERS, source_kind: "url", template_key: null },
    { id: MCP_OAUTH, source_kind: "template", template_key: "notion" },
  ], "the recommended Notion row is recognised as a Raft template; the custom one as a pasted URL");
});

test("⭐ existing assignments follow the default, and one that was switched off stays off", async () => {
  const pg = await migratedFromProductionShape();
  const { rows } = await pg.query<{ agent_id: string; enabled: boolean; allowed_tools: string[] | null; connection_mode: string; bound_connection_id: string | null }>(
    `SELECT agent_id, enabled, allowed_tools, connection_mode, bound_connection_id FROM managed_mcp_assignments ORDER BY agent_id`,
  );
  assert.deepEqual(rows, [
    // The tool restriction is kept and the Agent follows the default: it keeps working.
    { agent_id: AGENT_TOOLS, enabled: true, allowed_tools: ["search"], connection_mode: "default", bound_connection_id: null },
    // Switched off by an operator before the migration: must not be quietly turned back on.
    { agent_id: AGENT_OFF, enabled: false, allowed_tools: null, connection_mode: "default", bound_connection_id: null },
  ]);
});

test("⭐ an older binary updating enabled / allowed_tools leaves the connection choice alone", async () => {
  const pg = await migratedFromProductionShape();
  // New code pins the Agent to a Connection...
  await pg.exec(`
    UPDATE managed_mcp_assignments SET connection_mode = 'pinned', bound_connection_id = '${CRED_HEADERS}'
      WHERE agent_id = '${AGENT_TOOLS}';
  `);
  // ...then an old binary, mid-deploy, writes the only columns it knows, the way it writes them.
  await pg.exec(`
    INSERT INTO managed_mcp_assignments (server_id, agent_id, mcp_server_id, enabled, allowed_tools)
      VALUES ('${SERVER}', '${AGENT_TOOLS}', '${MCP_HEADERS}', true, '["search","write"]')
      ON CONFLICT (agent_id, mcp_server_id) DO UPDATE SET
        enabled = excluded.enabled,
        allowed_tools = excluded.allowed_tools,
        assignment_version = managed_mcp_assignments.assignment_version + 1;
  `);
  const { rows } = await pg.query<{ allowed_tools: string[]; connection_mode: string; bound_connection_id: string | null }>(
    `SELECT allowed_tools, connection_mode, bound_connection_id FROM managed_mcp_assignments WHERE agent_id = '${AGENT_TOOLS}'`,
  );
  assert.deepEqual(rows[0], { allowed_tools: ["search", "write"], connection_mode: "pinned", bound_connection_id: CRED_HEADERS });
});

test("an App can hold several Connections, but only one server default", async () => {
  const pg = await migratedFromProductionShape();
  await pg.exec(`
    INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, header_names, is_server_default, auth_kind, name)
      VALUES (gen_random_uuid(), '${SERVER}', '${MCP_HEADERS}', '["X-Api-Key"]', false, 'headers', 'Second');
  `);
  const { rows } = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM managed_mcp_credentials WHERE mcp_server_id = '${MCP_HEADERS}'`,
  );
  assert.equal(rows[0].n, 2, "the one-credential-per-App index is gone");
  await assert.rejects(
    () => pg.exec(`
      INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, header_names, is_server_default)
        VALUES (gen_random_uuid(), '${SERVER}', '${MCP_HEADERS}', '[]', true);
    `),
    /idx_managed_mcp_credentials_default/,
    "a second server default is refused by the database",
  );
});

test("a pin cannot carry a Connection unless the mode is pinned", async () => {
  const pg = await migratedFromProductionShape();
  await assert.rejects(
    () => pg.exec(`
      UPDATE managed_mcp_assignments SET bound_connection_id = '${CRED_HEADERS}' WHERE agent_id = '${AGENT_TOOLS}';
    `),
    /managed_mcp_assignments_binding_matches_mode/,
  );
});
