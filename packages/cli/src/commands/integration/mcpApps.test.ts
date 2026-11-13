import assert from "node:assert/strict";

import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { formatIntegrationList, type IntegrationListResponse, type IntegrationMcpApp } from "./_format";
import { integrationEnvCommand } from "./env";
import { integrationInvokeCommand } from "./invoke";
import { integrationListCommand } from "./list";
import { integrationLoginCommand } from "./login";

// MCP Apps and Agent Login services are all Raft Apps, of different types. `raft integration list`
// shows the MCP Apps this Agent has (type MCP, its state, its tools); `invoke` / `env` / `login` on
// one say what it is instead of "not found".

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverId: "server-1",
  serverUrl: "https://api.raft.test",
  token: "secret",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function mcpApp(overrides: Partial<IntegrationMcpApp> = {}): IntegrationMcpApp {
  return {
    type: "mcp",
    id: "4f7a2c1e-0000-4000-8000-000000000001",
    name: "Team Notion",
    description: "Workspace pages",
    homepageUrl: "https://notion.example",
    state: "ready",
    access: "mcp_tools",
    toolCount: 2,
    toolNames: ["notion-search", "notion-fetch"],
    ...overrides,
  };
}

const ORDINARY = {
  id: "web-id",
  clientId: "web-only",
  appType: "server_local" as const,
  name: "Web Only",
  description: null,
  homepageUrl: "https://web.example",
  returnUrl: "https://web.example/auth/callback",
  agentManifestUrl: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

function listData(mcpApps: IntegrationMcpApp[] | undefined): IntegrationListResponse {
  return { services: [ORDINARY], activeLogins: [], ...(mcpApps ? { mcpApps } : {}) };
}

function memoryIo(): { io: CliIo; stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    },
  };
}

function context(io: CliIo, respond: (method: string, path: string) => ApiResponse<unknown>) {
  return createCommandContext({
    io,
    env: {} as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({ request: async (method: string, path: string) => respond(method, path) }) as any,
  });
}

function listResponse(data: IntegrationListResponse) {
  return (_method: string, path: string): ApiResponse<unknown> => {
    // `?service=` is the CLI asking the server about what the list doesn't name; this server (an older one) ignores it.
    assert.equal(path.split("?")[0], "/internal/agent-api/integrations");
    return { ok: true, status: 200, error: null, data };
  };
}

test("⭐ list shows each MCP App with type MCP, its state, its tools, and no Agent Login hint", () => {
  const output = formatIntegrationList(listData([
    mcpApp(),
    mcpApp({ id: "mcp-2", name: "Docs Search", state: "login_required", description: null, homepageUrl: null, toolCount: 1, toolNames: ["search"] }),
    mcpApp({ id: "mcp-3", name: "Paused Tracker", state: "disabled", toolCount: 0, toolNames: [] }),
  ]));
  const section = output.slice(output.indexOf("MCP Apps (used through their MCP tools"));
  assert.ok(section.length > 0 && output.indexOf("Registered services:") < output.indexOf("MCP Apps ("), "a section after the Agent Login inventory");
  assert.match(section, /^MCP Apps \(used through their MCP tools, not `invoke`; `login` asks a person for access or a connection\):$/mu);

  const notion = section.slice(section.indexOf("- Team Notion"), section.indexOf("- Docs Search"));
  assert.deepEqual(notion.trim().split("\n"), [
    "- Team Notion",
    "  type: MCP",
    "  id: 4f7a2c1e-0000-4000-8000-000000000001",
    "  state: ready",
    '  tools: 2 ("notion-search", "notion-fetch")',
    "  homepage: https://notion.example",
    "  description: Workspace pages",
    "  next: call its MCP tools from your runtime; they are in your tool list (if not yet, use raft_app_tools / raft_app_call)",
  ]);
  assert.match(section, /- Docs Search\n {2}type: MCP\n[^]*?state: needs sign-in\n {2}tools: 1 \("search"\)\n {2}next: run `raft integration login --service "mcp-2" --target <channel-or-thread>` to post a request card in that conversation for a person who can connect it \(calling any of its tools from a conversation raises the same card there\)/u);
  assert.match(section, /- Paused Tracker[^]*?state: disabled on this server\n {2}tools: 0\n/u);
  assert.doesNotMatch(section, /raft integration invoke --service/u, "no invoke is offered for an MCP App");
  assert.doesNotMatch(notion, /raft integration login/u, "a ready App the Agent has needs no request");
  // The ordinary service keeps its own block and login hint.
  assert.match(output, /- Web Only[^]*?next: raft integration login --service "web-only"/u);
});

test("list says when the server does not report MCP Apps, and 'none' when there are none", () => {
  assert.match(formatIntegrationList(listData(undefined)), /MCP Apps \([^\n]*\):\n- not reported: this server predates MCP Apps in this list; see your Apps tab/u);
  assert.match(formatIntegrationList(listData([])), /MCP Apps \([^\n]*\):\n- none$/u);
  const many = formatIntegrationList(listData([mcpApp({ toolCount: 12, toolNames: Array.from({ length: 12 }, (_, i) => `t${i}`) })]));
  // Tool names come from the remote server, so each is quoted on one line.
  assert.match(many, /tools: 12 \("t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", \+2 more\)/u);
});

test("list --json passes the server's mcpApps through, and adds none for an older server", async () => {
  const withApps = memoryIo();
  await integrationListCommand.handler(context(withApps.io, listResponse(listData([mcpApp()]))), { json: true });
  const body = JSON.parse(withApps.stdout.join("")) as { data: IntegrationListResponse; observationScope: { includes: string[] } };
  assert.deepEqual(body.data.mcpApps, [mcpApp()]);
  assert.ok(body.observationScope.includes.includes("mcp_apps"));

  const older = memoryIo();
  await integrationListCommand.handler(context(older.io, listResponse(listData(undefined))), { json: true });
  assert.deepEqual(Object.keys((JSON.parse(older.stdout.join("")) as { data: object }).data).sort(), ["activeLogins", "services"]);
});

async function rejectsAsMcpApp(run: () => Promise<unknown>, command: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(String(error.code), "INTEGRATION_SERVICE_IS_MCP_APP");
    assert.match(error.message, /"Team Notion" is an MCP App \(type: MCP\), not an Agent Login service/u);
    assert.match(error.message, new RegExp(`\`raft integration ${command}\` does not apply to it`, "u"));
    assert.match(error.message, /State: needs sign-in; next: run `raft integration login --service "[^"]+" --target <channel-or-thread>` to post a request card/u);
    return true;
  });
}

test("⭐ invoke and env on an MCP App (by name or id) say what it is, not 'not found'", async () => {
  const data = listData([mcpApp({ state: "login_required" })]);
  const { io } = memoryIo();
  await rejectsAsMcpApp(async () => { await integrationInvokeCommand.handler(context(io, listResponse(data)), undefined, undefined, { service: "team notion", listActions: true }); }, "invoke");
  await rejectsAsMcpApp(async () => { await integrationEnvCommand.handler(context(io, listResponse(data)), { service: mcpApp().id }); }, "env");
  // A name that is neither stays an ordinary not-found.
  await assert.rejects(
    async () => { await integrationInvokeCommand.handler(context(io, listResponse(data)), undefined, undefined, { service: "nothing", listActions: true }); },
    (error: unknown) => error instanceof CliError && String(error.code) === "INTEGRATION_NOT_FOUND",
  );
});

test("⭐ an MCP App this Agent lacks is listed with its grant, and its next step is the login request", () => {
  const output = formatIntegrationList(listData([
    mcpApp({ id: "mcp-9", name: "Wiki", state: "ready", grant: "not_granted" }),
    mcpApp({ id: "mcp-8", name: "Board", state: "ready", grant: "revoked" }),
  ]));
  assert.match(output, /- Wiki\n {2}type: MCP\n {2}id: mcp-9\n {2}grant: not granted\n {2}state: ready/u);
  assert.match(output, /- Wiki[^]*?next: run `raft integration login --service "mcp-9" --target <channel-or-thread>` to post a request card in that conversation for a person who can grant you this App/u);
  assert.match(output, /- Board[^]*?grant: revoked[^]*?next: run `raft integration login --service "mcp-8"/u);
  // An older server sends no grant: every listed App was one the Agent has.
  assert.doesNotMatch(formatIntegrationList(listData([mcpApp()])), /grant:/u);
});

test("⭐ login on an MCP App: a posted request, a ready App and a missing --target are answers, not failures", async () => {
  for (const [errorCode, status] of [
    ["INTEGRATION_MCP_CONNECTION_REQUESTED", "mcp_connection_requested"],
    ["INTEGRATION_MCP_APP_READY", "mcp_app_ready"],
    ["INTEGRATION_MCP_TARGET_REQUIRED", "mcp_target_required"],
  ] as const) {
    const text = memoryIo();
    const message = `server says ${errorCode}`;
    const respond = () => ({ ok: false, status: 409, data: null, error: message, errorCode });
    await integrationLoginCommand.handler(context(text.io, respond), { service: "Team Notion", target: "#apps" });
    assert.equal(text.stdout.join("").trim(), message, `${errorCode}: the server's message is printed`);
    const json = memoryIo();
    await integrationLoginCommand.handler(context(json.io, respond), { service: "Team Notion", json: true });
    assert.deepEqual(JSON.parse(json.stdout.join("")), { ok: true, data: { status, type: "mcp", message } });
  }
});

test("login on a disabled MCP App surfaces the server's message with its code", async () => {
  const { io } = memoryIo();
  const message = "\"Paused Tracker\" is an MCP App ... It is switched off on this Server; a Server owner/admin can switch it on.";
  const ctx = context(io, () => ({ ok: false, status: 409, data: null, error: message, errorCode: "INTEGRATION_MCP_APP_DISABLED" }));
  await assert.rejects(async () => { await integrationLoginCommand.handler(ctx, { service: "Paused Tracker" }); }, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(String(error.code), "INTEGRATION_MCP_APP_DISABLED");
    assert.equal(error.message, message);
    return true;
  });
});
