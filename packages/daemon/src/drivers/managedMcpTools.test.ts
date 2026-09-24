import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createManagedMcpPiTools } from "./managedMcpTools.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("managed MCP Pi tools remain absent without a runner credential", async () => {
  assert.deepEqual(await createManagedMcpPiTools({ serverUrl: "https://raft.test", agentCredentialKey: null }), []);
});

test("managed MCP Pi tools freeze the snapshot and proxy calls through agent-api", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/mcp/tools")) {
      return new Response(JSON.stringify({
        catalogVersion: 1,
        tools: [{
          mcpServerId: "11111111-1111-4111-8111-111111111111",
          serverName: "Docs",
          toolName: "search",
          runtimeName: "mcp_11111111_search_deadbeef",
          description: "Search docs",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          configVersion: 3,
          assignmentVersion: 4,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "found" }], isError: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const tools = await createManagedMcpPiTools({ serverUrl: "https://raft.test", agentCredentialKey: "sk_agent_test" });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mcp_11111111_search_deadbeef");
  const result = await tools[0].execute("call-1", { query: "MCP" }, undefined, undefined, {} as never);
  assert.deepEqual(result.content, [{ type: "text", text: "found" }]);
  assert.equal(calls.length, 2);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer sk_agent_test");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    toolName: "search",
    arguments: { query: "MCP" },
    expectedConfigVersion: 3,
    expectedAssignmentVersion: 4,
  });
});

test("managed MCP snapshot failures are non-fatal and bounded", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "forbidden", code: "capability_not_authorized" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
  const warnings: string[] = [];
  const tools = await createManagedMcpPiTools({
    serverUrl: "https://raft.test",
    agentCredentialKey: "sk_agent_test",
    onWarning: (warning) => warnings.push(warning),
  });
  assert.deepEqual(tools, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /capability_not_authorized \(403\)/u);
  assert.ok(warnings[0].length < 300);
});
